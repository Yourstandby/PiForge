import { NextResponse } from "next/server";
import { getRequestId } from "@/lib/api-error";
import { getAgentHostClient } from "@/lib/agent-host-client";
import { jsonAgentHostError } from "@/lib/agent-host-http";

export const dynamic = "force-dynamic";

/** GET /api/memory/health */
export async function GET(req: Request) {
  const requestId = getRequestId(req);
  try {
    const health = await getAgentHostClient().call("memory.health", {});
    return NextResponse.json(health, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return jsonAgentHostError(req, error, { route: "/api/memory/health", method: "GET" });
  }
}
