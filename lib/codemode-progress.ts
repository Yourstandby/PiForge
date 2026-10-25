/**
 * codemode 脚本内的调用进度：把 SDK 的 `tool_execution_update.details.calls` 折成一行可读文本。
 *
 * 为什么需要：SDK 在脚本每次内层调用前后都会 `onUpdate({content: [], details: {calls}})`，
 * 但 `content` 是空数组 —— 渲染层只看文本，于是长脚本执行期间界面一片静止。这里只做
 * 「把结构折成一行」，不改脚本的返回值，也不碰 SDK。
 *
 * 输出示例：`bash ✓1.2s · read …  · edit ✗0.3s`
 *   ✓ 成功、✗ 失败、⊘ 取消、… 运行中；超过 5 条截断成 `… +N`。
 */

/** SDK 侧一条内层调用的记录（`execute.js` 里的 `record`）。 */
export interface CodemodeCallRecord {
  name?: unknown;
  status?: unknown;
  durationMs?: unknown;
}

const MAX_VISIBLE_CALLS = 5;

function statusMark(status: unknown): string {
  switch (status) {
    case "ok":
      return "✓";
    case "error":
      return "✗";
    case "cancelled":
      return "⊘";
    default:
      // "running" 以及任何未知状态：脚本还活着，别谎报成功。
      return "…";
  }
}

function durationSuffix(durationMs: unknown): string {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) return "";
  const seconds = durationMs / 1000;
  // 不足 10s 保留一位小数；更长的脚本没必要给毫秒级噪音。
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

/** `calls` → 单行进度。空列表返回空串（调用方据此跳过提交）。 */
export function formatCodemodeProgress(calls: readonly CodemodeCallRecord[]): string {
  if (!Array.isArray(calls) || calls.length === 0) return "";
  const visible = calls.slice(0, MAX_VISIBLE_CALLS);
  const parts = visible.map((call) => {
    const name = typeof call?.name === "string" && call.name.trim() ? call.name.trim() : "tool";
    const mark = statusMark(call?.status);
    return `${name} ${mark}${durationSuffix(call?.durationMs)}`;
  });
  const hidden = calls.length - visible.length;
  if (hidden > 0) parts.push(`… +${hidden}`);
  return parts.join(" · ");
}

/**
 * 从 `tool_execution_update` 的 `partialResult`（或最终结果）里取进度行。
 * 不是 codemode 形状就返回空串，调用方继续走原来的文本通道。
 */
export function formatCodemodeProgressFromResult(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object") return "";
  const calls = (details as { calls?: unknown }).calls;
  if (!Array.isArray(calls)) return "";
  return formatCodemodeProgress(calls as CodemodeCallRecord[]);
}

/**
 * 超时 / 取消之后，SDK 已要求 VM 停止，但 worker 要真的退出才释放槽位
 * （`pi-codemode` 的 `onWorkerStarted(exited)` 语义）。我们没有队列状态的接口，
 * 只能从错误文案推导一行日志 —— 它是**推断**，不是实时槽位状态，文案里写清楚。
 */
export function describeCodemodeFailure(text: string, pool: number): string | null {
  if (!text) return null;
  const slotHeld =
    /Execution timed out after \d+ ms/.test(text) ||
    /Script timed out/.test(text) ||
    /Script aborted/.test(text);
  if (slotHeld) {
    return `worker still exiting, slot held (pool=${pool}) — inferred from the timeout, not a live slot probe`;
  }
  if (/No codemode worker became free within \d+ seconds/.test(text)) {
    return `all codemode workers busy for 60s, script never started (pool=${pool})`;
  }
  return null;
}
