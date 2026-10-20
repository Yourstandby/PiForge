import { NextResponse } from "next/server";
import { getRequestId, jsonError } from "@/lib/api-error";
import { getAgentHostClient } from "@/lib/agent-host-client";
import { jsonAgentHostError } from "@/lib/agent-host-http";

export const dynamic = "force-dynamic";

/** POST /api/memory/forget — body: { cwd, memoryIds?, observationIds? } */
export async function POST(req: Request) {
  const requestId = getRequestId(req);
  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return jsonError(req, 400, "JSON body is required");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return jsonError(req, 400, "JSON body is required");
    }
    const input = body as {
      cwd?: string;
      memoryIds?: string[];
      observationIds?: string[];
    };
    if (!input.cwd) return jsonError(req, 400, "cwd is required");

    const result = await getAgentHostClient().call("memory.forget", {
      cwd: input.cwd,
      ...(input.memoryIds !== undefined ? { memoryIds: input.memoryIds } : {}),
      ...(input.observationIds !== undefined ? { observationIds: input.observationIds } : {}),
    });
    return NextResponse.json(result, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return jsonAgentHostError(req, error, { route: "/api/memory/forget", method: "POST" });
  }
}
