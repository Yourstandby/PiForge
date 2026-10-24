/**
 * 多 Agent 的「省钱阀门」（任务三）。
 *
 * 子 Agent / 舰队 Agent 的成本不是"一次调用"，而是**主 Agent ↔ 子 Agent 之间反复
 * 来回**：每追一问，子 Agent 都要把整段上下文重新送一遍，主 Agent 又要把回包再送一遍。
 * 所以这里设三道硬闸：
 *
/**
 * 多 Agent 的「省钱阀门」（任务三）。
 *
 * 子 Agent / 舰队 Agent 的成本不是"一次调用"，而是**主 Agent ↔ 子 Agent 之间反复
 * 来回**：每追一问，子 Agent 都要把整段上下文重新送一遍，主 Agent 又要把回包再送一遍。
 * 所以这里设三道闸：
 *
 *   1. 轮数上限：**可配置**（默认 6 轮，`PIFORGE_SUBAGENT_MAX_TURNS` 覆盖）；
 *      触达后不静默 abort，而是回一份 `need_help` 报告（含已用轮数 / 最后一次有效动作）；
 *   2. 强制摘要：回给主 Agent 的永远是一段极简摘要，原始长日志只留在面板里；
 *   3. 上下文熔断：单个 Agent 单轮上下文超过 10k tokens 立刻中断并标错。
 *
 * 为什么上限从 3 提到 6：实测（docs/optimizations/subagent-runtime-audit.md）
 * 内聚模块任务需要 4–5 次工具调用，3 轮硬阀先于"连续 5 轮无进展"的 progress-guard
 * 触发，导致后者永远不生效、任务全部静默取消。上限必须**高于**空转阈值（5），
 * 空转阀才轮得到生效。
 */

/** 一次性子 Agent 的默认轮数上限（含第 1 轮）。 */
export const DEFAULT_SUBAGENT_MAX_TURNS = 6;
/** 覆盖一次性子 Agent 轮数上限的环境变量。 */
export const SUBAGENT_MAX_TURNS_ENV = "PIFORGE_SUBAGENT_MAX_TURNS";
/** 兼容旧名：默认上限（不是硬编码常量，因为可被环境变量覆盖）。 */
export const MAX_DISCUSSION_TURNS = DEFAULT_SUBAGENT_MAX_TURNS;
/** 单个 Agent 单轮上下文上限（token）。超过就熔断。 */
export const CONTEXT_BREAKER_TOKENS = 10_000;
/** 回给主 Agent 的摘要上限（字符）≈ 300 tokens。 */
export const MAX_PARENT_REPORT_CHARS = 1_200;
/** 摘要在面板里指向原始输出的提示。 */
export const REPORT_TRUNCATED_NOTICE = "（完整输出留在右侧 Agents 面板，这里只给摘要）";

export interface TurnLimitDecision {
  maxTurns: number;
  source: "default" | "env" | "env_invalid";
  reason: string;
}

/**
 * 解析轮数上限：`PIFORGE_SUBAGENT_MAX_TURNS` > 默认 6。
 * 非法值（非整数 / <1 / NaN）回落默认并写明原因 —— 宁可多给一轮，
 * 也不要因为一个手滑的环境变量把子 Agent 全部封死。
 */
export function resolveSubagentMaxTurns(
  env: Record<string, string | undefined> = process.env,
): TurnLimitDecision {
  const raw = env[SUBAGENT_MAX_TURNS_ENV]?.trim();
  if (!raw) {
    return {
      maxTurns: DEFAULT_SUBAGENT_MAX_TURNS,
      source: "default",
      reason: `未设置 ${SUBAGENT_MAX_TURNS_ENV}：默认 ${DEFAULT_SUBAGENT_MAX_TURNS} 轮`,
    };
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
    return {
      maxTurns: DEFAULT_SUBAGENT_MAX_TURNS,
      source: "env_invalid",
      reason: `${SUBAGENT_MAX_TURNS_ENV}="${raw}" 非法（需 ≥1 的整数），回落默认 ${DEFAULT_SUBAGENT_MAX_TURNS} 轮`,
    };
  }
  return { maxTurns: parsed, source: "env", reason: `${SUBAGENT_MAX_TURNS_ENV}=${parsed}` };
}

export interface TurnBudget {
  allowed: boolean;
  /** 即将使用的那一轮的序号（1 起）。 */
  turns: number;
  /** `null` = 无硬上限（常驻舰队 Agent）。 */
  maxTurns: number | null;
  reason?: string;
}

/**
 * 还能不能再开一轮？
 *
 * `turns` 是**即将使用的那一轮的序号**（1 起）—— 第 `maxTurns` 轮必须放行，
 * 第 `maxTurns + 1` 轮才拦。所以判据是 `used <= maxTurns`：
 * 早期用 `used < maxTurns` 等于少给一轮（off-by-one，实测把 2 轮以上的任务
 * 全部误杀成 cancelled）。
 *
 * `maxTurns = null` → 无硬上限（常驻舰队）：只受 progress-guard 约束。
 */
export function checkTurnBudget(
  turns: number,
  maxTurns: number | null = DEFAULT_SUBAGENT_MAX_TURNS,
): TurnBudget {
  const used = Math.max(0, Math.floor(turns));
  if (maxTurns === null) {
    return { allowed: true, turns: used, maxTurns: null };
  }
  if (used <= maxTurns) {
    return { allowed: true, turns: used, maxTurns };
  }
  return {
    allowed: false,
    turns: used,
    maxTurns,
    reason:
      `已用满 ${maxTurns} 轮对话上限（单次请求-响应制）。` +
      "需要继续时，请让主 Agent 汇总已有结论、新建一个子 Agent 重新开始，而不是继续追问同一个。",
  };
}

export interface ContextBreach {
  breached: boolean;
  tokens: number;
  limit: number;
  reason?: string;
}

/**
 * 熔断判定。`tokens` 取不到（null / NaN / 负数）时不熔断 ——
 * 宁可少拦一次，也不要因为拿不到用量就把正常任务打断。
 */
export function checkContextBreaker(
  tokens: number | null | undefined,
  limit = CONTEXT_BREAKER_TOKENS,
): ContextBreach {
  if (tokens === null || tokens === undefined || !Number.isFinite(tokens) || tokens <= 0) {
    return { breached: false, tokens: 0, limit };
  }
  const used = Math.round(tokens);
  if (used <= limit) return { breached: false, tokens: used, limit };
  return {
    breached: true,
    tokens: used,
    limit,
    reason:
      `上下文已达 ${used.toLocaleString()} tokens，超过单 Agent ${limit.toLocaleString()} tokens 熔断阈值。` +
      "已中断本轮：请缩小题问范围，或把任务拆成几个短任务重新派发。",
  };
}

/**
 * 把子 Agent 的最终输出压成「一句话/极简摘要」再回给主 Agent。
 *
 * 只做确定性压缩（不额外调模型，避免为了省钱再花一次钱）：
 *   - 去掉重复空行、行尾空白；
 *   - 保留开头的结论段 + 最多 6 条要点行（`-` / `*` / `1.` / 路径:行号）；
 *   - 超出预算就在句末截断并标注。
 */
export function condenseReport(
  raw: string,
  budget: number = MAX_PARENT_REPORT_CHARS,
): { text: string; condensed: boolean } {
  const source = (raw ?? "").replace(/\r/g, "").replace(/[ \t]+$/gm, "");
  const lines = source
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line, index, all) => !(line === "" && index > 0 && all[index - 1] === ""));
  const cleaned = lines.join("\n").trim();
  if (!cleaned) return { text: "(子 Agent 没有产出文本)", condensed: false };
  if (cleaned.length <= budget) return { text: cleaned, condensed: false };

  const bullet = /^\s*(?:[-*•]|\d+[.)])\s+/;
  const kept: string[] = [];
  let used = 0;
  for (const line of cleaned.split("\n")) {
    const isBullet = bullet.test(line);
    // 只留结论行与要点行，正文段落超过 3 行就不再累计。
    if (!isBullet && kept.filter((item) => !bullet.test(item)).length >= 3) continue;
    if (used + line.length + 1 > budget - REPORT_TRUNCATED_NOTICE.length - 8) break;
    kept.push(line);
    used += line.length + 1;
  }
  const body = kept.join("\n").trim() || cleaned.slice(0, Math.max(0, budget - 80)).trim();
  return {
    text: `${body}\n\n${REPORT_TRUNCATED_NOTICE}`,
    condensed: true,
  };
}

/** 熔断/超限时回给主 Agent 的统一文案（tool result 里直接给模型看）。 */
export function guardFailureText(kind: "turns" | "context" | "progress", detail: string): string {
  const label = kind === "turns" ? "轮数上限" : kind === "context" ? "上下文熔断" : "空转中断";
  return `【${label}】${detail}\n（这是省钱阀门主动中断，不是工具报错；请调整策略后继续。）`;
}

/** 阀门类型：轮数 / 空转 / 上下文。 */
export type GuardTrip = "turns" | "progress" | "context";

export interface SubagentFailureInput {
  id: string;
  name: string;
  /** 控件里的状态（cancelled / failed / timed out…）。 */
  status: string;
  /** 命中的阀门；null = 没命中阀门（超时 / 父 Agent 取消 / 真实报错）。 */
  trip: GuardTrip | null;
  /** 已用轮数。 */
  turns: number;
  /** 轮数上限；null = 无硬上限（常驻舰队）。 */
  maxTurns: number | null;
  /** 最后一次有效动作（如 `read agent-host/subagents.ts（ok）`）；null = 从没调用过工具。 */
  lastAction: string | null;
  /** 原始原因（guard 原文 / 异常文本）。 */
  reason?: string | null;
  timedOut?: boolean;
}

/**
 * ok:false 的回包文案 —— 一次性子 Agent 与常驻舰队共用。
 *
 * 为什么不用一句 `Sub-agent "x" was cancelled.`：那句话把“轮数用完 / 空转 / 上下文熔断 /
 * 真报错”压成同一个字符串，主 Agent 无法区分“缺上下文”和“死循环”，只能原样重试（烧钱）。
 * 这里把 id / 已用轮数 / 最后一次有效动作 / 下一步建议全部拼上。
 */
export function buildSubagentFailureReport(input: SubagentFailureInput): string {
  const limit = input.maxTurns === null ? "无硬上限" : String(input.maxTurns);
  const lastAction = input.lastAction ?? "无（从未调用过任何工具）";
  const status = input.trip === "turns" || input.trip === "progress" ? "need_help" : "failed";
  const headline = (() => {
    if (input.timedOut) return "超时被中断";
    if (input.trip === "turns") return "轮数上限已用满，需要主 Agent 接手";
    if (input.trip === "progress") return "连续多轮无进展，已按空转中断";
    if (input.trip === "context") return "单轮上下文超限（10k tokens 熔断）";
    if (input.status === "cancelled") return "被主 Agent 取消";
    return "执行失败";
  })();
  const nextSteps = (() => {
    if (input.trip === "turns") {
      return (
        "拆成 2–3 个更小的子任务重派（每个任务只对应一个函数/文件），" +
        "或在 taskPrompt 里直接给 file:line 锚点省掉寻路轮数；" +
        "需要接着同一段上下文时改用 herdr_spawn 常驻舰队 Agent（无硬轮数上限）。"
      );
    }
    if (input.trip === "progress") {
      return (
        "不要原样重试。补上入口文件路径 / 函数名后拆小任务重派；" +
        "若任务本身需要长时间探索，改用 herdr_spawn 常驻舰队 Agent。"
      );
    }
    if (input.trip === "context") {
      return (
        "缩小范围（只给一个文件或一段函数）后重派，避免把大输出读进子 Agent 上下文；" +
        "需要持续跟进则改用 herdr_spawn 常驻舰队 Agent 分步做。"
      );
    }
    if (input.timedOut) {
      return "任务过大：拆成几个短任务重派（或换常驻舰队 Agent），不要原样重试。";
    }
    return "先看 reason：缺文件/缺权限就补上再重派，同一输入不要原样重试。";
  })();

  const lines = [
    `Sub-agent "${input.name}" (${input.id}) 未交付：${headline}`,
    `status: ${status}`,
    `turns: ${input.turns}/${limit}`,
    `last_action: ${lastAction}`,
    `reason: ${(input.reason ?? "unknown error").replace(/\s+/g, " ").trim()}`,
    `next_steps: ${nextSteps}`,
  ];
  return lines.join("\n");
}
