import { probeAgentHost } from "../../../lib/agent-host-client.ts";

export async function GET() {
  const host = await probeAgentHost();
  return Response.json({ ok: true, host });
}
