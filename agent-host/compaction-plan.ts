/**
 * 历史滑动窗口 + 摘要（第三维度）。
 *
 * 长会话的成本不是线性的：每一轮都要把整段历史重新送一遍。Pi 自带按 Token 阈值
 * 触发的压缩，但那个切点是**按 token 猜的**，经常把最近几轮对话劈成两半，
 * 或者压得太晚（已经付了好几轮全量上下文的钱）。
 *
 * 这里换两个确定性规则：
 *   1. 滑动窗口：最近 N 轮（默认 6）**原样保留**，切点永远落在用户消息上
 *      （不劈轮次，不会把工具调用和它的结果拆开）；
 *   2. 双触发：窗口里攒够可压缩的轮次（默认 ≥3 轮）**或**上下文占用超过窗口预算
 *      （默认 60%）就压，两个条件谁先到算谁。
 *
 * 摘要结构固定四段（用户意图 / 修改文件 / 关键报错 / 最终决策），并且**文件清单
 * 由代码再兜一次**，模型漏写也不会丢。
 *
 * 本文件是纯函数：不碰 LLM、不碰磁盘，方便直接单测。
 */

/** 保留最近多少轮完整原文。 */
export const KEEP_RECENT_ROUNDS = 4;
/** 窗口外至少攒够几轮才值得压一次（压 1 轮要付一次摘要调用，不划算）。 */
export const MIN_ROUNDS_TO_DROP = 3;
/** 上下文占用超过窗口的这个比例就压，不看轮数。 */
export const CONTEXT_BUDGET_RATIO = 0.45;
/**
 * 被压区间至少要有这么多 token 才值得压。
 * 否则 pi 的 `prepareCompaction` 会直接返回 undefined（没东西可压）——
 * 那一次 `ctx.compact()` 白费不算，还会把当前回合 abort 掉。
 */
export const MIN_DROPPABLE_TOKENS = 3_000;
/** 摘要正文上限（字符）≈ 1.2k tokens：够用，且不会变成新的包袱。 */
export const MAX_SUMMARY_CHARS = 4_000;
/** 喂给摘要模型的对话文本预算（字符）≈ 7k tokens。 */
export const SUMMARY_INPUT_MAX_CHARS = 24_000;
/** 单条消息喂给摘要模型时的截断长度。 */
const MESSAGE_EXCERPT_CHARS = 600;
const TOOL_RESULT_EXCERPT_CHARS = 240;

/** 只依赖这几个字段，方便用普通对象测试。 */
export interface SessionEntryLike {
  type: string;
  id?: string;
  message?: MessageLike;
  summary?: string;
  firstKeptEntryId?: string;
}

export interface MessageLike {
  role?: string;
  content?: unknown;
  toolCalls?: Array<{ name?: string; arguments?: unknown; input?: unknown }>;
}

/** 只看最后一次压缩之后的条目：`boundaryStart` 之前的已经被摘要过了。 */
export interface RoundWindow {
  /** 每一轮（用户消息）在 entries 里的下标。 */
  roundStarts: number[];
  /** 可以安全重压的起始下标（最后一次压缩保留区间的第一条）。 */
  boundaryStart: number;
  /** 上一次压缩的摘要（迭代更新用）。 */
  previousSummary: string | null;
  /** 最后一次压缩条目的下标，没有就是 -1。 */
  lastCompactionIndex: number;
}

export function readRoundWindow(entries: readonly SessionEntryLike[]): RoundWindow {
  let lastCompactionIndex = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.type === "compaction") {
      lastCompactionIndex = index;
      break;
    }
  }

  let boundaryStart = 0;
  let previousSummary: string | null = null;
  if (lastCompactionIndex >= 0) {
    const entry = entries[lastCompactionIndex];
    previousSummary = typeof entry?.summary === "string" ? entry.summary : null;
    const keptId = entry?.firstKeptEntryId;
    const keptIndex = keptId ? entries.findIndex((item) => item.id === keptId) : -1;
    /**
     * 真实分支是**追加式**的：`appendCompaction` 把压缩条目挂到当前 leaf，
     * 所以保留区间的原文（id = firstKeptEntryId 起）在数组里位于压缩条目**之前**。
     * 找不到就退化为「压缩条目之后」，宁可少压也不重复压。
     */
    boundaryStart = keptIndex >= 0 ? keptIndex : lastCompactionIndex + 1;
  }

  const roundStarts: number[] = [];
  for (let index = boundaryStart; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry?.type === "message" && entry.message?.role === "user") roundStarts.push(index);
  }
  return { roundStarts, boundaryStart, previousSummary, lastCompactionIndex };
}

export interface CompactionDecision {
  trigger: boolean;
  /** 触发原因：窗口满 / Token 预算超限。 */
  reason: "window" | "budget" | null;
  /** 窗口外可压缩的轮数。 */
  droppableRounds: number;
  /** 被压缩区间的体积估算（token）。 */
  droppableTokens: number;
  tokens: number | null;
  contextWindow: number;
}

/**
 * 双条件触发：
 * - `window`：窗口外已经攒够 `minDropRounds` 轮（默认 3）；
 * - `budget`：上下文占用 ≥ `budgetRatio`（默认 60%）且至少还有 1 轮可压。
 * 两者都要求被压区间够大（`minDroppableTokens`，默认 3k tokens）。
 */
export function decideCompaction(input: {
  rounds: number;
  tokens: number | null;
  contextWindow: number;
  droppableTokens?: number;
  keepRounds?: number;
  minDropRounds?: number;
  budgetRatio?: number;
  minDroppableTokens?: number;
}): CompactionDecision {
  const keepRounds = input.keepRounds ?? KEEP_RECENT_ROUNDS;
  const minDropRounds = input.minDropRounds ?? MIN_ROUNDS_TO_DROP;
  const budgetRatio = input.budgetRatio ?? CONTEXT_BUDGET_RATIO;
  const minDroppableTokens = input.minDroppableTokens ?? MIN_DROPPABLE_TOKENS;
  const droppableRounds = Math.max(0, input.rounds - keepRounds);
  const droppableTokens = Math.max(0, Math.round(input.droppableTokens ?? 0));
  const base = {
    droppableRounds,
    droppableTokens,
    tokens: input.tokens ?? null,
    contextWindow: input.contextWindow,
  };
  /** 区间太小时任何原因都不值。 */
  if (droppableTokens < minDroppableTokens) {
    return { trigger: false, reason: null, ...base };
  }

  if (droppableRounds >= minDropRounds) {
    return { trigger: true, reason: "window", ...base };
  }
  const tokens = input.tokens ?? null;
  const overBudget =
    tokens !== null &&
    input.contextWindow > 0 &&
    tokens / input.contextWindow >= budgetRatio &&
    droppableRounds >= 1;
  if (overBudget) return { trigger: true, reason: "budget", ...base };
  return { trigger: false, reason: null, ...base };
}

export interface CompactionCut {
  /** 压缩后开始保留的 entry id（永远是用户消息 → 不会劈开一轮）。 */
  firstKeptEntryId: string;
  /** 被摘要的 entry 下标区间 `[from, to)`。 */
  from: number;
  to: number;
  /** 被摘要掉的消息原文（喂给摘要模型）。 */
  messages: MessageLike[];
  roundsDropped: number;
  roundsKept: number;
  previousSummary: string | null;
}

/**
 * 规划切点：保留最近 `keepRounds` 轮原文，其余全部进摘要。
 * 任何前提不满足都返回 null（交给 Pi 自己的默认压缩，绝不硬来）。
 */
export function planCompactionCut(
  entries: readonly SessionEntryLike[],
  keepRounds: number = KEEP_RECENT_ROUNDS,
): CompactionCut | null {
  const window = readRoundWindow(entries);
  const { roundStarts } = window;
  if (roundStarts.length <= keepRounds) return null;

  const cutIndex = roundStarts[roundStarts.length - keepRounds];
  const cutEntry = entries[cutIndex];
  if (!cutEntry?.id) return null;

  const messages: MessageLike[] = [];
  for (let index = window.boundaryStart; index < cutIndex; index += 1) {
    const entry = entries[index];
    if (entry?.type !== "message" || !entry.message) continue;
    // system 属于提示词状态，不进对话摘要。
    if (entry.message.role === "system") continue;
    messages.push(entry.message);
  }
  if (messages.length === 0) return null;

  return {
    firstKeptEntryId: cutEntry.id,
    from: window.boundaryStart,
    to: cutIndex,
    messages,
    roundsDropped: roundStarts.length - keepRounds,
    roundsKept: keepRounds,
    previousSummary: window.previousSummary,
  };
}

/* -------------------------------------------------------------------------- */
/* 摘要生成                                                                    */
/* -------------------------------------------------------------------------- */

/** 摘要模型必须遵守的结构（也用于 `/compact` 手动压缩）。 */
export function compactionSummaryInstructions(): string {
  return [
    "把上面的较早对话压缩成一份上下文检查点，**只用下面四段**，总长尽量 ≤ 400 字：",
    "",
    "## 1. 用户核心意图",
    "- 用户到底要做什么 + 验收标准。意图变过就只写当前有效的那一版。",
    "## 2. 修改过的文件",
    "- 每行 `路径` + 一句话说明改了什么；没有就写「无」。",
    "## 3. 关键报错 / 事实",
    "- 仍然有效的报错原文（最多 3 条）、接口签名、环境约束；已修好的中间报错不要留。",
    "## 4. 最终决策",
    "- 已定下来的方案与理由；未决事项单独一行以 `TODO:` 开头。",
    "",
    "硬性要求：",
    "- 不要复述工具输出原文，不要贴大段代码（最多保留 1–2 行关键签名）。",
    "- 不要写「总结如下」「希望有帮助」这类客套话。",
    "- 有 <previous-summary> 时，把旧摘要里仍然有效的信息合并进来，不要丢掉已确认的决策。",
  ].join("\n");
}

/** 摘要模型调用被拒绝 / 泄漏模板时的坏输出识别。 */
export function isUsableSummary(raw: string): boolean {
  const text = raw.trim();
  if (text.length < 40) return false;
  if (/^(?:i (?:can't|cannot)|unable to|as an ai)/i.test(text)) return false;
  // 模型偶尔把提示词原样吐回来。
  return !text.includes("把上面的较早对话压缩成一份上下文检查点");
}

/** 从消息里抽出读写过的文件（模型漏写时兜底用）。 */
export function extractFilePaths(messages: readonly MessageLike[]): {
  readFiles: string[];
  modifiedFiles: string[];
} {
  const read = new Set<string>();
  const modified = new Set<string>();
  const WRITE_TOOLS = new Set(["write", "edit", "create_file", "apply_patch", "str_replace_editor"]);
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.toolCalls)) continue;
    for (const call of message.toolCalls) {
      const name = typeof call?.name === "string" ? call.name : "";
      const input = (call?.arguments ?? call?.input) as Record<string, unknown> | undefined;
      const rawPath = input?.path ?? input?.file_path ?? input?.filePath ?? input?.filename;
      if (typeof rawPath !== "string" || !rawPath.trim()) continue;
      const path = rawPath.trim();
      if (WRITE_TOOLS.has(name)) modified.add(path);
      else if (name === "read") read.add(path);
    }
  }
  return {
    readFiles: [...read].filter((path) => !modified.has(path)).sort(),
    modifiedFiles: [...modified].sort(),
  };
}

export interface SummaryAssembly {
  summary: string;
  /** 是否用了代码兜底（模型摘要不可用）。 */
  fallback: boolean;
  modifiedFiles: string[];
}

/**
 * 组装最终摘要：正文 + **代码兜底的文件清单**。
 * 文件段永远由代码追加，模型写没写都不影响「改了哪些文件」这一条不丢。
 * 模型不可用时先回退到上一次的摘要（信息量远大于一句"不可用"）。
 */
export function assembleCompactionSummary(
  raw: string | null,
  extras: {
    modifiedFiles?: readonly string[];
    readFiles?: readonly string[];
    previousSummary?: string | null;
    reason?: string;
  } = {},
): SummaryAssembly {
  const modifiedFiles = [...(extras.modifiedFiles ?? [])];
  const cleaned = (raw ?? "")
    .replace(/^```[a-zA-Z]*\s*/g, "")
    .replace(/```\s*$/g, "")
    .trim();
  const previous = (extras.previousSummary ?? "").trim();
  const usable = isUsableSummary(cleaned);
  const body = usable
    ? cleaned.length > MAX_SUMMARY_CHARS
      ? `${cleaned.slice(0, MAX_SUMMARY_CHARS).trimEnd()}\n…`
      : cleaned
    : isUsableSummary(previous)
      ? [
          "（本轮摘要模型不可用，下面是上一次的检查点，仍然有效）",
          "",
          previous.length > MAX_SUMMARY_CHARS
            ? `${previous.slice(0, MAX_SUMMARY_CHARS).trimEnd()}\n…`
            : previous,
        ].join("\n")
      : [
          "## 1. 用户核心意图",
          "（自动摘要不可用，只保留代码提取的改动清单；更早的细节已不可用）",
          "",
          "## 2. 修改过的文件",
          "（见下方自动提取清单）",
          "",
          "## 3. 关键报错 / 事实",
          "（无）",
          "",
          "## 4. 最终决策",
          "（无）",
        ].join("\n");

  const fileLines = modifiedFiles.length > 0
    ? modifiedFiles.map((path) => `- ${path}`)
    : ["- （无）"];
  const readLines =
    extras.readFiles && extras.readFiles.length > 0
      ? ["", "只读过（未修改）：", ...extras.readFiles.map((path) => `- ${path}`)]
      : [];

  const summary = [
    body,
    "",
    "## 自动提取 · 修改过的文件",
    ...fileLines,
    ...readLines,
  ].join("\n");

  return { summary, fallback: !usable, modifiedFiles };
}

/** 粗估一段消息的 token（与工具输出预算同一套口径：3.2 字符/token）。 */
export function estimateMessagesTokens(messages: readonly MessageLike[]): number {
  let chars = 0;
  for (const message of messages) {
    chars += messageText(message.content).length;
    for (const call of message.toolCalls ?? []) {
      chars += 24;
      if (call?.arguments) chars += JSON.stringify(call.arguments).length;
    }
  }
  return Math.ceil(chars / 3.2);
}

/** 把消息序列化成摘要用文本：每条都截断，整体有预算。 */
export function serializeMessagesForSummary(
  messages: readonly MessageLike[],
  maxChars: number = SUMMARY_INPUT_MAX_CHARS,
): string {
  const blocks: string[] = [];
  let used = 0;
  for (const message of messages) {
    const line = serializeMessage(message);
    if (!line) continue;
    if (used + line.length > maxChars) {
      blocks.push("… （更早的对话已省略）");
      break;
    }
    blocks.push(line);
    used += line.length + 1;
  }
  return blocks.join("\n");
}

function serializeMessage(message: MessageLike): string {
  const role = message.role ?? "";
  const text = messageText(message.content);
  if (role === "user") {
    return `[用户] ${excerpt(text, MESSAGE_EXCERPT_CHARS)}`;
  }
  if (role === "assistant") {
    const parts: string[] = [];
    if (text.trim()) parts.push(excerpt(text, MESSAGE_EXCERPT_CHARS));
    for (const call of message.toolCalls ?? []) {
      if (!call?.name) continue;
      const args = (call.arguments ?? call.input) as Record<string, unknown> | undefined;
      const hint = args ? excerpt(singleLine(JSON.stringify(args)), 120) : "";
      parts.push(`→ ${call.name}${hint ? ` ${hint}` : ""}`);
    }
    return parts.length > 0 ? `[助手] ${parts.join("\n       ")}` : "";
  }
  if (role === "toolResult" || role === "tool_result") {
    return `[工具结果] ${excerpt(text, TOOL_RESULT_EXCERPT_CHARS)}`;
  }
  if (text.trim()) return `[${role}] ${excerpt(text, MESSAGE_EXCERPT_CHARS)}`;
  return "";
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const item = block as Record<string, unknown>;
    if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
    else if (item.type === "thinking" && typeof item.thinking === "string") continue;
  }
  return parts.join("\n");
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function excerpt(text: string, limit: number): string {
  const normalized = text.replace(/\r/g, "").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit).trimEnd()}…`;
}
