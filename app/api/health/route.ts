import { getAgentHostClient } from "../../../lib/agent-host-client.ts";
import { resolveSessionSplitHint } from "../../../lib/token-guard.ts";

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

/**
 * 渲染层可见的实验开关（当前只有 L-B）。
 * 由 `PIFORGE_SESSION_SPLIT_HINT` 决定，默认关闭 → 与引入前行为一致。
 */
function featureFlags() {
  return { sessionSplitHint: resolveSessionSplitHint(process.env).enabled };
}

export async function GET() {
  const client = getAgentHostClient();
  try {
    const health = await client.call("host.health", {}, { timeoutMs: 1_200 });
    return Response.json({
      ok: true,
      flags: featureFlags(),
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
      flags: featureFlags(),
      host: "down",
      hostState: hostProbeState(client.status),
    });
  }
}
