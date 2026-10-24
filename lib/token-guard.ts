/**
 * Token 护栏的**纯提示层**（P2-2 / P2-3a）。
 *
 * 定位：可见性，不是省 token 的机制。
 *   - P2-2：同一会话里工具集/系统提示词变了（`agent.state.prefixAudit` 的
 *     `unexpectedChanges > 0` 且工具被**移除**）→ 前缀整段失效，下一轮要把历史
 *     全部按未命中重发。跨 app 切换（两家共用 `~/.pi/agent`）最常触发这条。
 *   - P2-3a：恢复一个**真正闲置过**（`session.modified` 超过 10 分钟）且上下文很大的
 *     会话时，缓存可能已凉 → 第一次请求要重发 ≈N tok。刚开的活跃会话不提示：
 *     那种情况的数字只是当前上下文本身，说“恢复”就是误导。
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
/**
 * 恢复提示的空闲阈值：只有“真的闲置过”才算恢复。
 *
 * 之前只看“有消息 + 上下文 ≥20k”，于是**任何**活跃会话（包括刚开的、上下文
 * 43k 的）都会挂着“恢复这个会话将重发 ≈43k tok”，而那一刻并没有任何恢复动作，
 * 数字只是把底部“上下文 x% / 窗口”换个说法。
 *
 * 省 token 视角：提示本身不进上下文，但误导性提示会推着用户去“开新会话 /
 * 重发探路”，反而制造真实开销；所以宁可只在一分钟内真正值得说的那一次出现。
 */
export const RESUME_IDLE_MS = 10 * 60_000;
/** 会话拆分建议的上下文阈值（≈ 本机 cacheRead 中位的 1.4 倍）。 */
export const SPLIT_TOKENS_THRESHOLD = 200_000;

export type TokenGuardKind = "prefix-invalidated" | "resume-cost" | "session-too-long";

export interface TokenGuardHint {
  kind: TokenGuardKind;
  /** 提示是否带"开新会话"的动作入口（L-B 实验臂才为 `new-session`）。 */
  action?: "new-session";
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

/**
 * L-B 实验开关：`PIFORGE_SESSION_SPLIT_HINT`（默认**关闭**）。
 *
 *   - 关闭（默认）：`session-too-long` 只是信息提示 —— 与引入本开关前**逐字节一致**；
 *   - `=1`：同一条提示升级为「建议动作」——文案强调成本、并给出「开新会话」按钮。
 *
 * 为什么默认关闭：L-B 的假设是"**给出可点的动作**才会改变用户行为"，
 * 光加一行信息不会（这一点要靠 adoption 率验证，见 context-governance-ab.md）。
 * 所以关 = 现状，开 = 实验臂，两臂之间只差"有没有动作入口"。
 */
export interface SessionSplitHintSetting {
  enabled: boolean;
  source: "default" | "env" | "env_invalid";
  reason: string;
}

export function resolveSessionSplitHint(
  env: Record<string, string | undefined> = {},
): SessionSplitHintSetting {
  const raw = env.PIFORGE_SESSION_SPLIT_HINT?.trim().toLowerCase();
  if (!raw) return { enabled: false, source: "default", reason: "默认关闭（只给信息提示）" };
  if (["1", "true", "on", "yes"].includes(raw)) {
    return { enabled: true, source: "env", reason: `PIFORGE_SESSION_SPLIT_HINT=${raw}` };
  }
  if (["0", "false", "off", "no"].includes(raw)) {
    return { enabled: false, source: "env", reason: `PIFORGE_SESSION_SPLIT_HINT=${raw}` };
  }
  return {
    enabled: false,
    source: "env_invalid",
    reason: `PIFORGE_SESSION_SPLIT_HINT="${raw}" 不是布尔值，保持关闭`,
  };
}

export interface TokenGuardFlags {
  /** L-B：会话过长时是否给「开新会话」动作（默认 false = 现状）。 */
  sessionSplitHint?: boolean;
}

export interface TokenGuardInput {
  /** 当前上下文 token 数（`agent.state.contextUsage.tokens`），用于估算重发成本。 */
  contextTokens?: number | null;
  /** 是否已经有过对话（全新会话不提示恢复成本）。 */
  hasMessages?: boolean;
  /** `agent.state.prefixAudit` */
  prefixAudit?: PrefixAuditView | null;
  /**
   * 会话文件最后活动时间（`session.modified`，ISO 字符串或 ms）。
   * 缺失 = 无从判断是否恢复 → `resume-cost` 不出现（宁可不说，也不误说）。
   */
  lastActivityAt?: string | number | null;
  /** 当前时间（ms），只给单测注入，运行时不传。 */
  now?: number;
  /** 用户手动关掉的 hint 类型集合（本会话内）。 */
  dismissed?: readonly TokenGuardKind[];
  /** 实验开关（L-B）。不传 = 全部关闭 = 与引入前逐字节一致。 */
  flags?: TokenGuardFlags;
}

function positive(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}

/** 把 `session.modified` 归一成 ms；无效值返回 null（无法判断空闲时长）。 */
function toMillis(value: string | number | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 空闲了多久（分钟，取下整）；无法判断时返回 null。 */
function idleMinutes(lastActivityAt: string | number | null | undefined, now: number): number | null {
  const last = toMillis(lastActivityAt);
  if (last === null) return null;
  const delta = now - last;
  if (!Number.isFinite(delta) || delta < RESUME_IDLE_MS) return null;
  return Math.floor(delta / 60_000);
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
  const now = typeof input.now === "number" && Number.isFinite(input.now) ? input.now : Date.now();
  const idle = idleMinutes(input.lastActivityAt, now);
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
    contextTokens >= RESUME_TOKENS_THRESHOLD &&
    idle !== null
  ) {
    hints.push({
      kind: "resume-cost",
      text: `这个会话闲置 ${idle} 分钟后恢复，将重发 ≈${formatTokens(contextTokens)} tok`,
      detail:
        "闲置超过 10 分钟缓存通常已凉，这次恢复按未命中计费。" +
        "想省 token 就先发一句短问题探路（让它接着聊），或直接开新会话。",
      estimatedTokens: contextTokens,
    });
  }

  if (!dismissed.has("session-too-long") && contextTokens >= SPLIT_TOKENS_THRESHOLD) {
    // L-B 实验臂：同一条提示 + 动作入口；关闭时与引入前完全一致（无 action 字段）。
    hints.push(
      input.flags?.sessionSplitHint === true
        ? {
            kind: "session-too-long",
            action: "new-session",
            text: `上下文 ≈${formatTokens(contextTokens)} tok，建议开新会话（每轮都在重读它）`,
            detail:
              "长会话的成本大头是每轮重读上下文（审计：cacheRead 占成本 56%）。" +
              "带着当前结论开新会话，能把后续每轮的重读量降下来。",
            estimatedTokens: contextTokens,
          }
        : {
            kind: "session-too-long",
            text: `当前会话上下文 ≈${formatTokens(contextTokens)} tok，每轮都要重读`,
            detail: "长会话的成本大头是每轮重读上下文（审计：cacheRead 占成本 56%）。可以考虑带着摘要开新会话。",
            estimatedTokens: contextTokens,
          },
    );
  }

  return hints;
}
