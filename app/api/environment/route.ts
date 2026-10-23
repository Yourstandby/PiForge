import { NextResponse } from "../../../lib/next-server-shim.ts";
import { getRequestId } from "../../../lib/api-error.ts";
import { getAgentHostClient } from "../../../lib/agent-host-client.ts";
import { jsonAgentHostError } from "../../../lib/agent-host-http.ts";

export const dynamic = "force-dynamic";

/**
 * GET /api/environment?refresh=1
 *
 * Proxies the Host's PATH scan (Node / Python / Git / Bash / Bun / jq …).
 * Probing stays in the Agent Host; Next never spawns anything.
 */
export async function GET(req: Request) {
  const requestId = getRequestId(req);
  try {
    const refresh = new URL(req.url).searchParams.get("refresh") === "1";
    const report = await getAgentHostClient().call(
      "env.probe",
      { refresh },
      { timeoutMs: 30_000 },
    );
    return NextResponse.json(report, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return jsonAgentHostError(req, error, { route: "/api/environment", method: "GET" });
  }
}
