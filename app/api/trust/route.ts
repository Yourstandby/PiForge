import { NextResponse } from "next/server";
import { getRequestId, jsonError } from "@/lib/api-error";
import { getAgentHostClient } from "@/lib/agent-host-client";
import { jsonAgentHostError } from "@/lib/agent-host-http";
import { isTrustOptionId } from "@/lib/trust-types";

export const dynamic = "force-dynamic";

/** POST /api/trust  body: { cwd, optionId } */
export async function POST(req: Request) {
  const requestId = getRequestId(req);
  try {
    const body = (await req.json()) as { cwd?: string; optionId?: string };
    if (!body.cwd || typeof body.cwd !== "string") {
      return jsonError(req, 400, "cwd is required");
    }
    if (!isTrustOptionId(body.optionId)) {
      return jsonError(req, 400, "optionId must be trust | trust-parent | trust-session | deny | deny-session");
    }
    const result = await getAgentHostClient().call("trust.apply", {
      cwd: body.cwd,
      optionId: body.optionId,
    });
    return NextResponse.json(result, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return jsonAgentHostError(req, error, { route: "/api/trust", method: "POST" });
  }
}

/** GET /api/trust?cwd= — status for UI / debugging */
export async function GET(req: Request) {
  const requestId = getRequestId(req);
  try {
    const cwd = new URL(req.url).searchParams.get("cwd");
    if (!cwd) {
      return jsonError(req, 400, "cwd is required");
    }
    const gate = await getAgentHostClient().call("trust.evaluate", { cwd });
    return NextResponse.json(gate, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return jsonAgentHostError(req, error, { route: "/api/trust", method: "GET" });
  }
}
