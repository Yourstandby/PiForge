import { NextResponse } from "../../../lib/next-server-shim.ts";
import { AgentHostError, getAgentHostClient } from "../../../lib/agent-host-client.ts";
import { errorMessage, getRequestId, logApiError } from "../../../lib/api-error.ts";

export const dynamic = "force-dynamic";

function hostError(error: unknown, requestId: string): Response {
  logApiError({ route: "/api/plugins", method: "GET/POST", requestId, error });
  if (error instanceof AgentHostError) {
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status: error.code === "E_INVALID_PARAMS" ? 400 : 503 },
    );
  }
  return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
}

export async function GET(req: Request) {
  const requestId = getRequestId(req);
  try {
    const data = await getAgentHostClient().call("plugins.list", {});
    return NextResponse.json(data, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return hostError(error, requestId);
  }
}

export async function POST(req: Request) {
  const requestId = getRequestId(req);
  try {
    const body = (await req.json()) as { id?: unknown; enabled?: unknown };
    if (typeof body.id !== "string" || typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "id and enabled are required" }, { status: 400 });
    }
    const data = await getAgentHostClient().call("plugins.setEnabled", {
      id: body.id,
      enabled: body.enabled,
    });
    return NextResponse.json(data, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return hostError(error, requestId);
  }
}
