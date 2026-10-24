import { NextResponse } from "../../../lib/next-server-shim.ts";
import type { CustomProviderInput } from "../../../contract/domains/providers.ts";
import { AgentHostError, getAgentHostClient } from "../../../lib/agent-host-client.ts";
import { errorMessage, getRequestId, jsonError, logApiError } from "../../../lib/api-error.ts";

export const dynamic = "force-dynamic";

function hostError(error: unknown): Response {
  if (error instanceof AgentHostError) {
    const status = error.code === "E_INVALID_PARAMS" ? 400 : 503;
    return NextResponse.json({ error: error.message, code: error.code }, { status });
  }
  return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
}

export async function GET() {
  try {
    const client = getAgentHostClient();
    const [providers, transport] = await Promise.all([
      client.call("models.providers.list", {}),
      client.call("host.transport", {}),
    ]);
    return NextResponse.json({ ...providers, transport });
  } catch (error) {
    return hostError(error);
  }
}

export async function POST(req: Request) {
  const requestId = getRequestId(req);
  try {
    const body = (await req.json()) as CustomProviderInput;
    const client = getAgentHostClient();
    const saved = await client.call("models.providers.save", body);
    return NextResponse.json(saved, { headers: { "x-request-id": requestId } });
  } catch (error) {
    logApiError({ route: "/api/providers", method: "POST", requestId, error });
    return hostError(error);
  }
}

export async function DELETE(req: Request) {
  const requestId = getRequestId(req);
  try {
    const id = new URL(req.url).searchParams.get("id")?.trim() ?? "";
    if (!id) return jsonError(req, 400, "id is required");
    const client = getAgentHostClient();
    return NextResponse.json(
      await client.call("models.providers.remove", { id }),
      { headers: { "x-request-id": requestId } },
    );
  } catch (error) {
    logApiError({ route: "/api/providers", method: "DELETE", requestId, error });
    return hostError(error);
  }
}
