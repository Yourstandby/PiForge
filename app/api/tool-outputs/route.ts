import { NextResponse } from "../../../lib/next-server-shim.ts";
import { getRequestId, jsonError } from "../../../lib/api-error.ts";
import { validateRequestOrigin } from "../../../lib/auth-policy.ts";
import { getAgentHostClient } from "../../../lib/agent-host-client.ts";
import { jsonAgentHostError } from "../../../lib/agent-host-http.ts";

export const dynamic = "force-dynamic";

/**
 * POST /api/tool-outputs — page through a persisted oversized tool result.
 * The Host validates the path is one of its own `sessions/**\/tool-outputs`
 * files and performs the read; Next only proxies.
 */
export async function POST(req: Request) {
  const requestId = getRequestId(req);
  const originError = validateRequestOrigin(req);
  if (originError) {
    return jsonError(req, 403, originError);
  }
  try {
    const body = (await req.json()) as { file?: string; offset?: number; limit?: number };
    const file = body?.file?.trim();
    if (!file) return jsonError(req, 400, "file is required");
    if (body.offset !== undefined && (typeof body.offset !== "number" || !Number.isFinite(body.offset) || body.offset < 0)) {
      return jsonError(req, 400, "offset must be a non-negative number");
    }
    if (body.limit !== undefined && (typeof body.limit !== "number" || !Number.isFinite(body.limit) || body.limit < 1)) {
      return jsonError(req, 400, "limit must be a positive number");
    }
    const page = await getAgentHostClient().call(
      "toolOutput.read",
      {
        file,
        ...(body.offset !== undefined ? { offset: body.offset } : {}),
        ...(body.limit !== undefined ? { limit: body.limit } : {}),
      },
      { timeoutMs: 20_000 },
    );
    return NextResponse.json(page, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return jsonAgentHostError(req, error, { route: "/api/tool-outputs", method: "POST" });
  }
}
