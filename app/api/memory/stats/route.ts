import { NextResponse } from "next/server";
import { getRequestId, jsonError } from "@/lib/api-error";
import { getAgentHostClient } from "@/lib/agent-host-client";
import { jsonAgentHostError } from "@/lib/agent-host-http";

export const dynamic = "force-dynamic";

/** GET /api/memory/stats?cwd= */
export async function GET(req: Request) {
  const requestId = getRequestId(req);
  try {
    const cwd = new URL(req.url).searchParams.get("cwd");
    if (!cwd) return jsonError(req, 400, "cwd is required");
    const stats = await getAgentHostClient().call("memory.stats", { cwd });
    return NextResponse.json(stats, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return jsonAgentHostError(req, error, { route: "/api/memory/stats", method: "GET" });
  }
}
