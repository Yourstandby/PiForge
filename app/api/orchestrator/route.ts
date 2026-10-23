import { NextResponse } from "../../../lib/next-server-shim.ts";
import { AgentHostError, getAgentHostClient } from "../../../lib/agent-host-client.ts";
import { errorMessage, getRequestId, logApiError } from "../../../lib/api-error.ts";

export const dynamic = "force-dynamic";

function hostError(error: unknown): Response {
  if (error instanceof AgentHostError) {
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status: error.code === "E_INVALID_PARAMS" ? 400 : 503 },
    );
  }
  return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
}

export async function GET() {
  try {
    return NextResponse.json(await getAgentHostClient().call("orchestrator.list", {}));
  } catch (error) {
    return hostError(error);
  }
}

export async function POST(req: Request) {
  const requestId = getRequestId(req);
  try {
    const body = (await req.json()) as { action?: unknown; id?: unknown };
    if (body.action !== "stop" || typeof body.id !== "string") {
      return NextResponse.json({ error: "action=stop and id are required" }, { status: 400 });
    }
    const data = await getAgentHostClient().call("orchestrator.stop", { id: body.id });
    return NextResponse.json(data, { headers: { "x-request-id": requestId } });
  } catch (error) {
    logApiError({ route: "/api/orchestrator", method: "POST", requestId, error });
    return hostError(error);
  }
}
