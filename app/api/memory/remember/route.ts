import { NextResponse } from "next/server";
import { getRequestId, jsonError } from "@/lib/api-error";
import { getAgentHostClient } from "@/lib/agent-host-client";
import { jsonAgentHostError } from "@/lib/agent-host-http";
import type { MemoryType } from "@contract/domains/memory";

export const dynamic = "force-dynamic";

/** POST /api/memory/remember — body: { cwd, content, type?, concepts?, files? } */
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
      content?: string;
      type?: MemoryType;
      concepts?: string[];
      files?: string[];
    };
    if (!input.cwd) return jsonError(req, 400, "cwd is required");
    if (typeof input.content !== "string" || input.content.trim().length === 0) {
      return jsonError(req, 400, "content is required");
    }

    const result = await getAgentHostClient().call("memory.remember", {
      cwd: input.cwd,
      content: input.content,
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.concepts !== undefined ? { concepts: input.concepts } : {}),
      ...(input.files !== undefined ? { files: input.files } : {}),
    });
    return NextResponse.json(result, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return jsonAgentHostError(req, error, { route: "/api/memory/remember", method: "POST" });
  }
}
