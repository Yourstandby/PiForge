import { NextResponse } from "next/server.js";
import { getRequestId, jsonError } from "../../../lib/api-error.ts";
import { validateRequestOrigin } from "../../../lib/auth-policy.ts";
import { getAgentHostClient } from "../../../lib/agent-host-client.ts";
import { jsonAgentHostError } from "../../../lib/agent-host-http.ts";

export const dynamic = "force-dynamic";

/** GET /api/subagents — snapshot of the Host's sub-agent list. */
export async function GET(req: Request) {
  const requestId = getRequestId(req);
  try {
    const snapshot = await getAgentHostClient().call("subagents.list", {});
    return NextResponse.json(snapshot, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return jsonAgentHostError(req, error, { route: "/api/subagents", method: "GET" });
  }
}

/** POST /api/subagents — { action: "stop", id } aborts a running child. */
export async function POST(req: Request) {
  const requestId = getRequestId(req);
  const originError = validateRequestOrigin(req);
  if (originError) return jsonError(req, 403, originError);
  try {
    const body = (await req.json()) as { action?: string; id?: string };
    if (body?.action !== "stop") return jsonError(req, 400, "action must be 'stop'");
    const id = body.id?.trim();
    if (!id) return jsonError(req, 400, "id is required");
    const stopped = await getAgentHostClient().call("subagents.stop", { id });
    return NextResponse.json(stopped, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return jsonAgentHostError(req, error, { route: "/api/subagents", method: "POST" });
  }
}
