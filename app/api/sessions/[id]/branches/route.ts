import { NextResponse } from "../../../../../lib/next-server-shim.ts";
import { getRequestId, jsonError } from "../../../../../lib/api-error.ts";
import { validateRequestOrigin } from "../../../../../lib/auth-policy.ts";
import { getAgentHostClient } from "../../../../../lib/agent-host-client.ts";
import { jsonAgentHostError } from "../../../../../lib/agent-host-http.ts";

export const dynamic = "force-dynamic";

/**
 * Session tree + branch switching. The Host reads the JSONL tree and moves the
 * live AgentSession leaf; Next only proxies.
 */

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestId = getRequestId(req);
  try {
    const { id } = await params;
    if (!id) return jsonError(req, 400, "sessionId is required");
    const filePath = new URL(req.url).searchParams.get("filePath") ?? undefined;
    const branches = await getAgentHostClient().call("sessions.getBranches", {
      sessionId: id,
      ...(filePath ? { filePath } : {}),
    });
    return NextResponse.json(branches, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return jsonAgentHostError(req, error, { route: "/api/sessions/[id]/branches", method: "GET" });
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestId = getRequestId(req);
  const originError = validateRequestOrigin(req);
  if (originError) return jsonError(req, 403, originError);
  try {
    const { id } = await params;
    if (!id) return jsonError(req, 400, "sessionId is required");
    const body = (await req.json()) as { leafId?: string | null; filePath?: string };
    if (body?.leafId !== null && (typeof body?.leafId !== "string" || !body.leafId.trim())) {
      return jsonError(req, 400, "leafId must be a non-empty string or null");
    }
    const switched = await getAgentHostClient().call("sessions.switchBranch", {
      sessionId: id,
      leafId: body.leafId,
      ...(body.filePath ? { filePath: body.filePath } : {}),
    });
    return NextResponse.json(switched, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return jsonAgentHostError(req, error, { route: "/api/sessions/[id]/branches", method: "POST" });
  }
}
