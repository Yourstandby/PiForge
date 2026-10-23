/**
 * 前缀缓存（prompt caching）地基：把「发给模型的那段前缀」变成可审计、可断言的东西。
 *
 * 命中缓存的条件很苛刻 —— 请求体的**字节级前缀**必须完全一致：
 *   [system prompt 全文][tools 数组的声明顺序与内容][历史消息]
 * 任何一处抖动（工具顺序变了、提示词里混进时间戳 / cwd、工具增删）
 * 都会让后面所有历史按未命中重新计费，长会话里这笔钱远大于输出。
 *
 * 因此这里只做三件不依赖 SDK 内部的事：
 *   1. `canonicalToolOrder()`：工具名去重 + ASCII 字典序，确保序列化结果唯一；
 *   2. `buildPrefixSnapshot()` / `diffPrefixSnapshots()`：把当前前缀摊平成可比较
 *      的分段快照，并说清「到底哪一段变了」；
 *   3. `userContextBlock()`：把易变状态（cwd 等）搬进用户消息的载体，
 *      让 system prompt 保持绝对静态。
 */
import { createHash } from "node:crypto";

/**
 * 工具名比较：**ASCII 码点序**，不是 `localeCompare`。
 * locale 化比较在不同语言环境 / ICU 版本下结果可能不同，那会让同一份工具集合
 * 在不同机器上排出不同顺序 —— 直接换来一次全量缓存未命中。
 */
export function compareToolName(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** 去重 + ASCII 字典序：同一份工具集合永远序列化成同一串字节。 */
export function canonicalToolOrder(names: readonly string[]): string[] {
  return [...new Set(names)].sort(compareToolName);
}

/** 系统提示词里允许进快照的字段（structural，避免把这层绑死在 SDK 类型上）。 */
export interface PrefixPromptOptions {
  customPrompt?: string;
  forceSystemPrompt?: string;
  appendSystemPrompt?: string;
  sections?: Record<string, string>;
  contextFiles?: Array<{ path: string; content: string }>;
  skills?: Array<{ name?: string; filePath?: string; description?: string }>;
  cwd?: string;
  toolSnippets?: Record<string, string>;
  toolGuidelines?: Record<string, string[]>;
  promptGuidelines?: string[];
}

/**
 * `system prompt` 里 **不静态** 的那一段替换成这句固定文本，
 * 真实 cwd 由 `userContextBlock()` 放进每条用户消息。
 */
export const STATIC_CWD_SECTION =
  "The session working directory is provided in the <context> block of each user message.";

/** 决定缓存前缀的全部输入：工具声明顺序 + 提示词各段。 */
export interface PrefixSnapshot {
  /** 发给 API 的 `tools` 顺序（就是 `setActiveTools()` 的入参顺序）。 */
  tools: string[];
  /** 分段文本：key 是段名，value 是该段的精确内容 / 内容指纹。 */
  sections: Record<string, string>;
}

function sha1Short(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 16);
}

/** 对象里 key 顺序不参与比较：先排序再序列化。 */
function stableJson(value: unknown): string {
  if (value === undefined) return "";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort((a, b) => compareToolName(a[0], b[0]));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

/**
 * 摊平 `SystemPromptOptions`。
 *
 * 长内容（上下文文件 / skill 正文）只留指纹：快照要能逐字比较，但不必把那几十 KB
 * 复制一份；短内容（preamble / addendum / cwd / sections）保留原文，
 * 这样 diff 能直接指出第一个差异字符的位置。
 */
export function buildPrefixSnapshot(
  options: PrefixPromptOptions | undefined,
  tools: readonly string[],
): PrefixSnapshot {
  const sections: Record<string, string> = {};
  if (!options) {
    sections.tools = canonicalToolOrder(tools).join(",");
    return { tools: canonicalToolOrder(tools), sections };
  }

  sections.preamble = options.customPrompt ? options.customPrompt : "(default)";
  if (options.forceSystemPrompt !== undefined) {
    sections.force_system_prompt = sha1Short(options.forceSystemPrompt);
  }
  sections.addendum = options.appendSystemPrompt ?? "";
  sections.cwd = options.cwd ?? "";
  sections.custom_sections = stableJson(options.sections ?? {});
  sections.tool_snippets = stableJson(options.toolSnippets ?? {});
  sections.tool_guidelines = stableJson(options.toolGuidelines ?? {});
  sections.prompt_guidelines = stableJson(options.promptGuidelines ?? []);
  for (const file of options.contextFiles ?? []) {
    sections[`context_file:${file.path}`] = sha1Short(file.content);
  }
  for (const skill of options.skills ?? []) {
    const name = skill.name ?? skill.filePath ?? "unnamed";
    sections[`skill:${name}`] = sha1Short(stableJson(skill));
  }
  /** 工具集合同时进提示词的 `<tools>` 段，所以顺序也是提示词的一部分。 */
  sections.tools = canonicalToolOrder(tools).join(",");
  return { tools: canonicalToolOrder(tools), sections };
}

export interface PrefixDiff {
  /** 完全一致 → 这一段前缀可以整体命中缓存。 */
  identical: boolean;
  toolsAdded: string[];
  toolsRemoved: string[];
  /** 工具集合相同但顺序不同（缓存照样失效，因为序列化字节变了）。 */
  toolsReordered: boolean;
  sectionsAdded: string[];
  sectionsRemoved: string[];
  sectionsChanged: string[];
  /** 第一个差异字符的位置，定位「到底哪句话在动」。 */
  firstDivergence: { section: string; at: number; previous: string; next: string } | null;
  /** 一行中文摘要，直接进日志。 */
  summary: string;
}

function firstDiffOffset(previous: string, next: string): number | null {
  if (previous === next) return null;
  const limit = Math.min(previous.length, next.length);
  for (let index = 0; index < limit; index += 1) {
    if (previous[index] !== next[index]) return index;
  }
  return limit;
}

function excerpt(value: string, at: number, radius = 24): string {
  const start = Math.max(0, at - radius);
  const end = Math.min(value.length, at + radius);
  return `${start > 0 ? "…" : ""}${value.slice(start, end).replace(/\n/g, "⏎")}${end < value.length ? "…" : ""}`;
}

/**
 * 前缀棘轮审计（第 4 步）：同一会话里，除了「按需域第一次被激活」那一次，
 * 相邻两轮的 system prompt + tools 必须字节一致。不一致就说明有东西在悄悄抖动
 * （工具顺序、动态插值、cwd 之类），那是整段历史缓存作废的起点。
 */
export interface PrefixAudit {
  turns: number;
  /** 与前一轮一致（或首次建立）的次数。 */
  stableTurns: number;
  /** 允许的变化：按需域首次激活。 */
  expectedChanges: number;
  /** 不允许的变化：同样的声明集合却换了字节。 */
  unexpectedChanges: number;
  lastChange?: {
    expected: boolean;
    summary: string;
    toolsAdded: string[];
    toolsRemoved: string[];
    sectionsChanged: string[];
    toolsReordered: boolean;
  };
}

export function emptyPrefixAudit(): PrefixAudit {
  return { turns: 0, stableTurns: 0, expectedChanges: 0, unexpectedChanges: 0 };
}

/**
 * 判断这次前缀变化是不是「按需域首次激活」。
 *
 * 允许的唯一变化：tools 增加且只增加一个已知的按需域；system prompt 各段完全不变；
 * 已有工具的相对顺序不变。
 */
export function isExpectedPrefixChange(
  diff: PrefixDiff,
  onDemandDomains: readonly string[]
): boolean {
  if (diff.identical) return true;
  if (diff.toolsRemoved.length > 0) return false;
  if (diff.sectionsAdded.length > 0 || diff.sectionsRemoved.length > 0) return false;
  // `sections.tools` 就是声明集合的镜像：工具变了它必然变，不能算「别的段落也在动」。
  const otherSections = diff.sectionsChanged.filter((name) => name !== "tools");
  if (otherSections.length > 0) return false;
  if (diff.toolsReordered) return false;
  return diff.toolsAdded.length === 1 && onDemandDomains.includes(diff.toolsAdded[0]);
}

/** 把一次 diff 计入审计（纯函数，便于单测）。 */
export function recordPrefixChange(
  audit: PrefixAudit,
  diff: PrefixDiff,
  expected: boolean
): PrefixAudit {
  const next: PrefixAudit = {
    ...audit,
    turns: audit.turns + 1,
    stableTurns: diff.identical ? audit.stableTurns + 1 : audit.stableTurns,
    expectedChanges: expected && !diff.identical ? audit.expectedChanges + 1 : audit.expectedChanges,
    unexpectedChanges:
      !expected && !diff.identical ? audit.unexpectedChanges + 1 : audit.unexpectedChanges,
  };
  if (!diff.identical) {
    next.lastChange = {
      expected,
      summary: diff.summary,
      toolsAdded: [...diff.toolsAdded],
      toolsRemoved: [...diff.toolsRemoved],
      sectionsChanged: [...diff.sectionsChanged],
      toolsReordered: diff.toolsReordered,
    };
  }
  return next;
}

/** 比较两份前缀快照。`previous` 为 null 表示这是本会话的第一次。 */
export function diffPrefixSnapshots(
  previous: PrefixSnapshot | null,
  next: PrefixSnapshot,
): PrefixDiff {
  if (!previous) {
    return {
      identical: false,
      toolsAdded: [...next.tools],
      toolsRemoved: [],
      toolsReordered: false,
      sectionsAdded: Object.keys(next.sections),
      sectionsRemoved: [],
      sectionsChanged: [],
      firstDivergence: null,
      summary: `首次建立前缀：${next.tools.length} 个工具`,
    };
  }

  const previousTools = new Set(previous.tools);
  const nextTools = new Set(next.tools);
  const toolsAdded = next.tools.filter((name) => !previousTools.has(name));
  const toolsRemoved = previous.tools.filter((name) => !nextTools.has(name));
  const toolsReordered =
    toolsAdded.length === 0 &&
    toolsRemoved.length === 0 &&
    previous.tools.some((name, index) => name !== next.tools[index]);

  const sectionsAdded: string[] = [];
  const sectionsRemoved: string[] = [];
  const sectionsChanged: string[] = [];
  let firstDivergence: PrefixDiff["firstDivergence"] = null;
  for (const [name, value] of Object.entries(next.sections)) {
    const before = previous.sections[name];
    if (before === undefined) {
      sectionsAdded.push(name);
      continue;
    }
    if (before === value) continue;
    sectionsChanged.push(name);
    if (!firstDivergence) {
      const at = firstDiffOffset(before, value) ?? 0;
      firstDivergence = {
        section: name,
        at,
        previous: excerpt(before, at),
        next: excerpt(value, at),
      };
    }
  }
  for (const name of Object.keys(previous.sections)) {
    if (!(name in next.sections)) sectionsRemoved.push(name);
  }

  const identical =
    toolsAdded.length === 0 &&
    toolsRemoved.length === 0 &&
    !toolsReordered &&
    sectionsAdded.length === 0 &&
    sectionsRemoved.length === 0 &&
    sectionsChanged.length === 0;

  return {
    identical,
    toolsAdded,
    toolsRemoved,
    toolsReordered,
    sectionsAdded,
    sectionsRemoved,
    sectionsChanged,
    firstDivergence,
    summary: formatPrefixDiff({
      identical,
      toolsAdded,
      toolsRemoved,
      toolsReordered,
      sectionsAdded,
      sectionsRemoved,
      sectionsChanged,
      firstDivergence,
    }),
  };
}

function formatPrefixDiff(diff: Omit<PrefixDiff, "summary">): string {
  if (diff.identical) return "前缀未变（缓存可整段复用）";
  const parts: string[] = [];
  if (diff.toolsAdded.length > 0) parts.push(`+工具 ${diff.toolsAdded.join(",")}`);
  if (diff.toolsRemoved.length > 0) parts.push(`-工具 ${diff.toolsRemoved.join(",")}`);
  if (diff.toolsReordered) parts.push("工具顺序变化");
  if (diff.sectionsAdded.length > 0) parts.push(`+段 ${diff.sectionsAdded.join(",")}`);
  if (diff.sectionsRemoved.length > 0) parts.push(`-段 ${diff.sectionsRemoved.join(",")}`);
  if (diff.sectionsChanged.length > 0) parts.push(`改段 ${diff.sectionsChanged.join(",")}`);
  const where = diff.firstDivergence
    ? `；首处差异 @${diff.firstDivergence.at} (${diff.firstDivergence.section}): ${diff.firstDivergence.previous} → ${diff.firstDivergence.next}`
    : "";
  return `${parts.join(" / ")}${where}`;
}

/** 粗估前缀体量：中文 ≈ 1 token/字、英文 ≈ 4 字符/token，取折中 3.2。 */
export function estimatePrefixTokens(snapshot: PrefixSnapshot): number {
  let chars = 0;
  for (const [name, value] of Object.entries(snapshot.sections)) {
    // 指纹段（sha1）不代表真实体量，跳过以免低估。
    if (value.length === 16 && /^[0-9a-f]{16}$/.test(value)) continue;
    chars += name.length + value.length;
  }
  chars += snapshot.tools.reduce((total, name) => total + name.length + 2, 0);
  return Math.ceil(chars / 3.2);
}

/**
 * 每条用户消息携带的 `<context>` 块（易变状态只允许出现在这里）。
 * 位置在用户消息内部 → 永远在缓存前缀之后，不会把历史打成未命中。
 */
export function userContextBlock(fields: { cwd?: string | null }): string | null {
  const cwd = fields.cwd?.trim();
  if (!cwd) return null;
  return `<context>cwd: ${cwd.replace(/\\/g, "/")}</context>`;
}
