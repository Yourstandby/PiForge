/**
 * 多 Agent 的「省钱阀门」（任务三）。
 *
 * 子 Agent / 舰队 Agent 的成本不是"一次调用"，而是**主 Agent ↔ 子 Agent 之间反复
 * 来回**：每追一问，子 Agent 都要把整段上下文重新送一遍，主 Agent 又要把回包再送一遍。
 * 所以这里设三道硬闸：
 *
 *   1. 轮数上限：一次请求-响应制，最多 3 轮对话（第 4 轮直接拒绝，不是软提醒）；
 *   2. 强制摘要：回给主 Agent 的永远是一段极简摘要，原始长日志只留在面板里；
 *   3. 上下文熔断：单个 Agent 单轮上下文超过 10k tokens 立刻中断并标错。
 *
 * 纯函数 + 常量，两个 runner（subagents / herdr）共用同一套判定，方便单测。
 */

/** 主 Agent ↔ 子 Agent 的最大讨论轮数（含第 1 轮）。 */
export const MAX_DISCUSSION_TURNS = 3;
/** 单个 Agent 单轮上下文上限（token）。超过就熔断。 */
export const CONTEXT_BREAKER_TOKENS = 10_000;
/** 回给主 Agent 的摘要上限（字符）≈ 300 tokens。 */
export const MAX_PARENT_REPORT_CHARS = 1_200;
/** 摘要在面板里指向原始输出的提示。 */
export const REPORT_TRUNCATED_NOTICE = "（完整输出留在右侧 Agents 面板，这里只给摘要）";

export interface TurnBudget {
  allowed: boolean;
  /** 已用轮数 / 上限。 */
  turns: number;
  maxTurns: number;
  reason?: string;
}

/** 还能不能再开一轮？ */
export function checkTurnBudget(turns: number, maxTurns = MAX_DISCUSSION_TURNS): TurnBudget {
  const used = Math.max(0, Math.floor(turns));
  if (used < maxTurns) {
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
