/**
 * Token 护栏的**纯提示层**（P2-2 / P2-3a）。
 *
 * 定位：可见性，不是省 token 的机制。
 *   - P2-2：同一会话里工具集/系统提示词变了（`agent.state.prefixAudit` 的
 *     `unexpectedChanges > 0` 且工具被**移除**）→ 前缀整段失效，下一轮要把历史
 *     全部按未命中重发。跨 app 切换（两家共用 `~/.pi/agent`）最常触发这条。
 *   - P2-3a：恢复一个上下文很大的会话时，缓存可能已凉 → 第一次请求要重发 ≈N tok。
 *
 * 硬约束：**只读**。这里不 import 前缀机制、不写任何状态、不发请求；
 * `agent-host/prompt-prefix.ts` 与工具域一行未动。文案只做提示，不阻断。
 *
 * 审计依据（docs/optimizations/token-consumption-audit.md）：
 *   前缀失效 35 次 / 3.65M tok / $1.12（5%）；空闲恢复 44 次 / 750k tok / $0.22（1%）。
 * 所以这两个提示的价值是"让用户看见"，不承诺省钱。
 */

/** 恢复提示的上下文阈值：低于这个量级重发成本可以忽略（约 $0.006/次）。 */
export const RESUME_TOKENS_THRESHOLD = 20_000;
/** 会话拆分建议的上下文阈值（≈ 本机 cacheRead 中位的 1.4 倍）。 */
export const SPLIT_TOKENS_THRESHOLD = 200_000;

export type TokenGuardKind = "prefix-invalidated" | "resume-cost" | "session-too-long";

export interface TokenGuardHint {
  kind: TokenGuardKind;
  /** 一句话结论（气泡主文案）。 */
  text: string;
  /** 补充说明（工具名、变化摘要等）。 */
  detail: string | null;
  /** 预估会重发/持续付费的 token 数（用于显示）。 */
  estimatedTokens: number;
}

/** `prefixAudit` 的只读视图（来自 `agent.state.prefixAudit`，字段名保持不变）。 */
export interface PrefixAuditView {
  turns?: number;
  stableTurns?: number;
  expectedChanges?: number;
  unexpectedChanges?: number;
  lastChange?: {
    expected?: boolean;
    summary?: string;
    toolsRemoved?: string[];
    toolsAdded?: string[];
    sectionsChanged?: string[];
  } | null;
}

/**
 * 从渲染层已有的 transcript 估算"下一次请求会带上多少上下文 token"。
 *
 * 为什么需要它：未运行过的会话在 Host 里没有 wrapper，`agent.state` 返回的
 * `contextUsage.tokens` 是 null（实测打开 26MB 会话时就是 null）；而护栏要在
 * "恢复会话"这一刻就给出估算，所以退化为对 transcript 的粗略计数。
 * 口径与 `lib/live-usage.ts` 的 `estimateTokens` 一致（CJK≈1 字/token，其它≈4 字符/token）。
 */
export function estimateContextTokens(messages: readonly unknown[] | null | undefined): number {
  if (!Array.isArray(messages) || messages.length === 0) return 0;
  let cjk = 0;
  let other = 0;
  const addText = (text: unknown) => {
    if (typeof text !== "string" || text.length === 0) return;
    for (const char of text) {
      if (/[　-鿿＀-￯]/.test(char)) cjk += 1;
      else other += 1;
    }
  };
  const visitBlock = (block: unknown) => {
    if (!block || typeof block !== "object") return;
    const typed = block as { type?: string; text?: string; content?: unknown };
    if (typed.type === "text") addText(typed.text);
    if (typeof typed.content === "string") addText(typed.content);
    if (Array.isArray(typed.content)) typed.content.forEach(visitBlock);
  };
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const typed = message as { content?: unknown };
    if (typeof typed.content === "string") addText(typed.content);
    else if (Array.isArray(typed.content)) typed.content.forEach(visitBlock);
  }
  return Math.round(cjk + other / 4);
}

export interface TokenGuardInput {
  /** 当前上下文 token 数（`agent.state.contextUsage.tokens`），用于估算重发成本。 */
  contextTokens?: number | null;
  /** 是否已经有过对话（全新会话不提示恢复成本）。 */
  hasMessages?: boolean;
  /** `agent.state.prefixAudit` */
  prefixAudit?: PrefixAuditView | null;
  /** 用户手动关掉的 hint 类型集合（本会话内）。 */
  dismissed?: readonly TokenGuardKind[];
}

function positive(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}

/**
 * 前缀失效判定：只认"工具被移除"或"system prompt 段被改"。
 *
 * 纯新增工具（例如按需域首次激活 tool_search）**不算**风险 —— 那是正常路径，
 * 提示会变成噪音（这一点与 `prompt-prefix.ts` 的 `isExpectedPrefixChange` 语义一致）。
 */
export function isPrefixInvalidated(audit: PrefixAuditView | null | undefined): boolean {
  if (!audit) return false;
  if (positive(audit.unexpectedChanges) === 0) return false;
  const change = audit.lastChange;
  if (!change) return false;
  const removed = Array.isArray(change.toolsRemoved) ? change.toolsRemoved.filter(Boolean) : [];
  const sections = Array.isArray(change.sectionsChanged)
    ? change.sectionsChanged.filter((name) => name !== "tools")
    : [];
  return removed.length > 0 || sections.length > 0;
}

/**
 * 计算当前该显示哪条提示（最多一条，前缀失效优先于恢复成本）。
 *
 * 纯函数：同样的输入永远同样的输出，便于单测与"提示不改变任何机制"的审计。
 */
export function resolveTokenGuards(input: TokenGuardInput): TokenGuardHint[] {
  const dismissed = new Set(input.dismissed ?? []);
  const contextTokens = positive(input.contextTokens);
  const hints: TokenGuardHint[] = [];

  if (!dismissed.has("prefix-invalidated") && isPrefixInvalidated(input.prefixAudit)) {
    const change = input.prefixAudit?.lastChange;
    const removed = Array.isArray(change?.toolsRemoved) ? change?.toolsRemoved.filter(Boolean) ?? [] : [];
    const sections = Array.isArray(change?.sectionsChanged)
      ? (change?.sectionsChanged ?? []).filter((name) => name !== "tools")
      : [];
    const reasons: string[] = [];
    if (removed.length > 0) reasons.push(`工具被移除：${removed.slice(0, 3).join(", ")}`);
    if (sections.length > 0) reasons.push(`system prompt 变化：${sections.slice(0, 3).join(", ")}`);
    hints.push({
      kind: "prefix-invalidated",
      text: contextTokens > 0 ? `前缀已失效，本次请求将重发 ≈${formatTokens(contextTokens)} tok` : "前缀已失效，本次请求将重发整段历史",
      detail: reasons.length > 0 ? `${reasons.join("；")}。建议开新会话，或确认这是你刚切换过工具集/app。` : null,
      estimatedTokens: contextTokens,
    });
  }

  if (
    !dismissed.has("resume-cost") &&
    input.hasMessages === true &&
    contextTokens >= RESUME_TOKENS_THRESHOLD
  ) {
    hints.push({
      kind: "resume-cost",
      text: `恢复这个会话将重发 ≈${formatTokens(contextTokens)} tok（缓存可能已过期）`,
      detail: "间隔较久时缓存会失效，这次恢复按未命中计费。介意的话可以开新会话，或先发一条短消息探路。",
      estimatedTokens: contextTokens,
    });
  }

  if (!dismissed.has("session-too-long") && contextTokens >= SPLIT_TOKENS_THRESHOLD) {
    hints.push({
      kind: "session-too-long",
      text: `当前会话上下文 ≈${formatTokens(contextTokens)} tok，每轮都要重读`,
      detail: "长会话的成本大头是每轮重读上下文（审计：cacheRead 占成本 56%）。可以考虑带着摘要开新会话。",
      estimatedTokens: contextTokens,
    });
  }

  return hints;
}
