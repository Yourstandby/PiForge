import { getAgentHostClient } from "../../../lib/agent-host-client.ts";

export async function GET() {
  try {
    const health = await getAgentHostClient().call("host.health", {}, { timeoutMs: 1_200 });
    return Response.json({
      ok: true,
      host: health.ok ? "ok" : "down",
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
    return Response.json({ ok: true, host: "down" });
  }
}
