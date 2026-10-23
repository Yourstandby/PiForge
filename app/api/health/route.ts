import { getAgentHostClient } from "../../../lib/agent-host-client.ts";

/** Next 的客户端状态 → UI 状态串。导出便于单测，不改变运行时行为。 */
export type HostProbeState = "ready" | "starting" | "reconnecting" | "offline";

/**
 * 冷启动语义：`connecting`（管道还连不上）是"正在启动"，不是"断线重连"。
 *
 * 0.9.0 两者被合成了一句话（"后台引擎断开，正在重连…"），于是在 Host 还在加载
 * 的 5–20s 里 UI 一直报错，用户会去点重启。分开上报后渲染进程能显示
 * "引擎启动中（首屏不再被它阻塞）"。
 */
export function hostProbeState(status: string): HostProbeState {
  if (status === "ready") return "ready";
  if (status === "connecting" || status === "idle") return "starting";
  if (status === "reconnecting") return "reconnecting";
  return "offline";
}

export async function GET() {
  const client = getAgentHostClient();
  try {
    const health = await client.call("host.health", {}, { timeoutMs: 1_200 });
    return Response.json({
      ok: true,
      host: health.ok ? "ok" : "down",
      hostState: "ready",
      hostDetail: {
        pid: health.pid,
        uptimeMs: health.uptimeMs,
        protocolVersion: health.protocolVersion,
        sessions: health.sessions,
        processes: health.processes,
      },
    });
  } catch {
    // Next.js is still serving pages; only the engine is unavailable.
    return Response.json({
      ok: true,
      host: "down",
      hostState: hostProbeState(client.status),
    });
  }
}
