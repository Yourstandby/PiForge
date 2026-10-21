/**
 * User-facing error filtering.
 *
 * Transport plumbing errors (the Agent Host named pipe not being up yet, a
 * socket reset while the host restarts, …) are not actionable for users. They
 * used to surface verbatim in the UI as a red line such as
 * `connect ENOENT \\.\pipe\piforge-agent-6f1c…`, which only looks like a crash.
 *
 * Rule: hide transport noise from the UI, keep every other message, and let
 * developers see the raw text with an explicit opt-in:
 *   NEXT_PUBLIC_PIFORGE_DEBUG=1   (build time)
 *   localStorage.setItem("piforge.debug", "1")   (runtime)
 * both only take effect in a development build.
 */

const HOST_TRANSPORT_PATTERNS: readonly RegExp[] = [
  // 命名管道 / Unix socket 连接失败（Agent Host 尚未就绪）
  /connect ENOENT/i,
  /\\\\\.\\pipe\\/i,
  /ENOENT[\s\S]*\b(?:pipe|socket|agent[\s_-]?host)\b/i,
  // 连接层的其它常见失败
  /\bECONNREFUSED\b/,
  /\bECONNRESET\b/,
  /\bEPIPE\b/,
  /\bEAI_AGAIN\b/,
  /socket hang up/i,
  // Host 客户端自身的不可用状态
  /PIFORGE_AGENT_ENDPOINT/i,
  /PIFORGE_AGENT_TOKEN/i,
  /Agent Host (?:client )?(?:is )?(?:closed|unavailable|disconnected)/i,
  /hostUnavailable/i,
];

/** True when the message is transport/plumbing noise rather than a real fault. */
export function isHostTransportError(message: string): boolean {
  return HOST_TRANSPORT_PATTERNS.some((pattern) => pattern.test(message));
}

/** Diagnostics require a development build *and* an explicit opt-in. */
export function diagnosticsEnabled(): boolean {
  if (process.env.NODE_ENV !== "development") return false;
  if (process.env.NEXT_PUBLIC_PIFORGE_DEBUG === "1") return true;
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem("piforge.debug") === "1";
  } catch {
    return false;
  }
}

/**
 * What the UI is allowed to render.
 * - normal error    → the message, unchanged
 * - transport noise → `null` (hidden) unless diagnostics are enabled
 * - empty           → `null`
 */
export function visibleErrorMessage(raw: string | null | undefined): string | null {
  const message = typeof raw === "string" ? raw.trim() : "";
  if (!message) return null;
  if (!isHostTransportError(message)) return message;
  return diagnosticsEnabled() ? message : null;
}
