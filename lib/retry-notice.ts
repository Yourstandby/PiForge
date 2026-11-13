/**
 * 模型连接失败 / 自动重试的**可见层**（纯函数）。
 *
 * 背景：pi 在模型连不上时会发 `auto_retry_start`，里面带着真实原因
 * （`ECONNREFUSED 127.0.0.1:11434`、`401 invalid api key`、`ETIMEDOUT`…）。
 * Host 原样透传，reducer 也把它存进了 `retryInfo`，但**没有任何组件渲染它** ——
 * 于是界面只剩一个转圈的「思考中」，用户完全不知道是密钥错了、模型没起，
 * 还是网络断了。
 *
 * 两条硬约束：
 *  1. **不走 `lib/ui-error.ts` 的 `visibleErrorMessage`**。那套过滤是给 Agent Host
 *     命名管道用的，`ECONNREFUSED` / `ECONNRESET` / `ETIMEDOUT` 一律当噪声隐藏；
 *     模型端点的连接失败恰好长得一样，过滤掉就等于再次静默。
 *  2. 展示前做脱敏与截断：错误串里可能带 Authorization / api key，
 *     也可能是一整段 HTML 网关页。
 */

export type RetryNoticeInput = {
  attempt: number;
  maxAttempts: number;
  errorMessage?: string | null;
};

export type RetryNoticeView = {
  /** 「模型连接失败，正在重试（2/5）」 */
  title: string;
  /** 归一化后的原因（脱敏、折叠空白、限长）；无原因时为 null。 */
  detail: string | null;
  /** 针对这类原因该去检查什么。 */
  hint: string | null;
};

/** 原因最多保留多少字符：够看清错误码与端点，又不会撑爆输入框上方。 */
const MAX_DETAIL_CHARS = 240;

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Authorization: Bearer … 必须排在键名规则之前：后者只吃掉 "Authorization: Bearer"，
  // 会把 token 本体留在后面。
  [/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer ***"],
  // sk-… / pk-… / rk-…
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, "sk-***"],
  // api_key=… / Authorization: …
  [/(api[-_ ]?key|authorization)\s*[:=]\s*\S+/gi, "$1: ***"],
];

/** 抹掉密钥、折叠空白、超长截断。没有内容时返回 null。 */
export function sanitizeRetryMessage(raw: string | null | undefined): string | null {
  let text = typeof raw === "string" ? raw : "";
  if (!text) return null;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  text = text.replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (text.length <= MAX_DETAIL_CHARS) return text;
  return `${text.slice(0, MAX_DETAIL_CHARS - 1)}…`;
}

/**
 * 把常见失败翻译成一句「该检查什么」。
 *
 * 刻意只覆盖能给出**可执行动作**的几类；识别不出来就返回 null，
 * 让原文自己说话，而不是抛一句万能废话。
 */
export function retryCauseHint(message: string | null | undefined): string | null {
  const text = typeof message === "string" ? message : "";
  if (!text) return null;
  if (
    /(ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|network error|timed out|timeout)/i.test(
      text,
    )
  ) {
    return "检查模型服务是否在运行（本地模型请确认已启动）、Base URL 是否正确，以及代理/VPN 是否拦截了请求。";
  }
  if (/\b(401|403)\b|invalid api key|unauthorized|forbidden|authentication|api key/i.test(text)) {
    return "检查该服务商的 API 密钥是否有效，以及账号是否有这个模型的权限。";
  }
  if (/\b404\b|model not found|unknown model|does not exist|no such model/i.test(text)) {
    return "检查模型 ID 是否存在于该服务商（设置 → 模型）。";
  }
  if (/\b429\b|rate limit|too many requests|quota/i.test(text)) {
    return "触发了限流或配额，稍后会自动重试；也可以先换一个模型。";
  }
  if (/\b5\d\d\b|overloaded|server error|bad gateway|service unavailable/i.test(text)) {
    return "服务商暂时不可用，正在自动重试。";
  }
  return null;
}

/** `retryInfo` → 可直接渲染的视图。没有重试在进行时返回 null。 */
export function describeRetryNotice(info: RetryNoticeInput | null | undefined): RetryNoticeView | null {
  if (!info) return null;
  const attempt = Number.isFinite(info.attempt) && info.attempt > 0 ? Math.floor(info.attempt) : 1;
  const maxAttempts =
    Number.isFinite(info.maxAttempts) && info.maxAttempts > 0 ? Math.floor(info.maxAttempts) : 1;
  const detail = sanitizeRetryMessage(info.errorMessage);
  return {
    title:
      maxAttempts > 1
        ? `模型连接失败，正在重试（${attempt}/${maxAttempts}）`
        : "模型连接失败",
    detail,
    hint: retryCauseHint(detail),
  };
}
