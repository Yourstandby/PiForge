import { getAgentHostClient } from "../../../lib/agent-host-client.ts";

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
      hostState:
        client.status === "reconnecting" || client.status === "connecting"
          ? "reconnecting"
          : "offline",
    });
  }
}
