import { NextResponse } from "next/server.js";
import { getRequestId, jsonError } from "../../../lib/api-error.ts";
import { validateRequestOrigin } from "../../../lib/auth-policy.ts";
import { getAgentHostClient } from "../../../lib/agent-host-client.ts";
import { jsonAgentHostError } from "../../../lib/agent-host-http.ts";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const agents = await getAgentHostClient().call("herdr.list", {});
    return NextResponse.json(agents, { headers: { "x-request-id": getRequestId(req) } });
  } catch (error) {
    return jsonAgentHostError(req, error, { route: "/api/herdr", method: "GET" });
  }
}

export async function POST(req: Request) {
  const originError = validateRequestOrigin(req);
  if (originError) return jsonError(req, 403, originError);
  try {
    const body = (await req.json()) as { action?: unknown; id?: unknown };
    if (body.action !== "stop" || typeof body.id !== "string" || !body.id.trim()) {
      return jsonError(req, 400, "action=stop and id are required");
    }
    const result = await getAgentHostClient().call("herdr.stop", { id: body.id });
    return NextResponse.json(result, { headers: { "x-request-id": getRequestId(req) } });
  } catch (error) {
    return jsonAgentHostError(req, error, { route: "/api/herdr", method: "POST" });
  }
}
