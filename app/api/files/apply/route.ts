import { NextResponse } from "../../../../lib/next-server-shim.ts";
import { getRequestId, jsonError } from "../../../../lib/api-error.ts";
import { validateRequestOrigin } from "../../../../lib/auth-policy.ts";
import { getAgentHostClient } from "../../../../lib/agent-host-client.ts";
import { jsonAgentHostError } from "../../../../lib/agent-host-http.ts";

export const dynamic = "force-dynamic";

/**
 * POST /api/files/apply — write a Markdown code block into a project file.
 *
 * The Host canonicalizes the path, applies the writable-path policy and writes
 * the file atomically; Next only proxies the request.
 */
export async function POST(req: Request) {
  const requestId = getRequestId(req);
  const originError = validateRequestOrigin(req);
  if (originError) return jsonError(req, 403, originError);
  try {
    const body = (await req.json()) as {
      path?: string;
      content?: string;
      mode?: "overwrite" | "append";
    };
    const filePath = body?.path?.trim();
    if (!filePath) return jsonError(req, 400, "path is required");
    if (typeof body.content !== "string") return jsonError(req, 400, "content must be a string");
    if (body.mode !== "overwrite" && body.mode !== "append") {
      return jsonError(req, 400, "mode must be 'overwrite' or 'append'");
    }
    const applied = await getAgentHostClient().call(
      "files.applyCode",
      { path: filePath, content: body.content, mode: body.mode },
      { timeoutMs: 20_000 },
    );
    return NextResponse.json(applied, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return jsonAgentHostError(req, error, { route: "/api/files/apply", method: "POST" });
  }
}
