/**
 * Host 与主进程之间的「stdin 控制通道」协议（L1 传输层）。
 *
 * utilityProcess 有 `parentPort.postMessage()`，普通子进程没有 —— 所以 node 传输层
 * 用 stdin 传同样的指令。放在 `contract/` 是因为**两侧都要用**：
 *   - 主进程（electron/host-launcher.ts）写一帧；
 *   - host（agent-host/index.ts）读一帧。
 * 一处定义，避免两边 JSON 字段拼错却各自"能编译"。
 */

export interface HostShutdownCommand {
  type: "shutdown";
  reason?: string;
}

/** 主进程写进 host stdin 的一帧（带换行，host 按行解析）。 */
export function hostShutdownFrame(reason = "app-quit"): string {
  return `${JSON.stringify({ type: "shutdown", reason })}\n`;
}

/**
 * 解析 host 从 stdin 收到的一行。只有 `{"type":"shutdown"}` 有语义：
 * 其它内容（比如宿主误把日志写进 stdin）一律忽略 —— 不能因为多一行就把 host 关掉。
 */
export function parseHostStdinLine(line: string): HostShutdownCommand | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as { type?: unknown; reason?: unknown };
  if (record.type !== "shutdown") return null;
  return { type: "shutdown", ...(typeof record.reason === "string" ? { reason: record.reason } : {}) };
}
