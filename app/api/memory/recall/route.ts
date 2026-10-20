import { NextResponse } from "next/server";
import { getRequestId, jsonError } from "@/lib/api-error";
import { getAgentHostClient } from "@/lib/agent-host-client";
import { jsonAgentHostError } from "@/lib/agent-host-http";

export const dynamic = "force-dynamic";

/** GET /api/memory/recall?cwd=&q=&limit? */
export async function GET(req: Request) {
  const requestId = getRequestId(req);
  try {
    const params = new URL(req.url).searchParams;
    const cwd = params.get("cwd");
    const q = params.get("q");
    if (!cwd) return jsonError(req, 400, "cwd is required");
    if (!q) return jsonError(req, 400, "q is required");

    const limitRaw = params.get("limit");
    const limit = limitRaw === null || limitRaw === "" ? undefined : Number(limitRaw);
    const result = await getAgentHostClient().call("memory.recall", {
      cwd,
      q,
      ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
    });
    return NextResponse.json(result, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return jsonAgentHostError(req, error, { route: "/api/memory/recall", method: "GET" });
  }
}
