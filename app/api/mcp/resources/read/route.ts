import { NextResponse } from "next/server.js";
import { getRequestId, jsonError } from "../../../../../lib/api-error.ts";
import { validateRequestOrigin } from "../../../../../lib/auth-policy.ts";
import { getAgentHostClient } from "../../../../../lib/agent-host-client.ts";
import { jsonAgentHostError } from "../../../../../lib/agent-host-http.ts";
import type { McpScope } from "../../../../../contract/domains/mcp.ts";

export const dynamic = "force-dynamic";

/** Read one MCP resource's contents through the host connection. */
export async function POST(req: Request) {
  const requestId = getRequestId(req);
  const originError = validateRequestOrigin(req);
  if (originError) return jsonError(req, 403, originError);
  try {
    const body = (await req.json()) as {
      id?: string;
      scope?: McpScope;
      cwd?: string;
      uri?: string;
    };
    const serverId = body?.id?.trim();
    const uri = body?.uri?.trim();
    if (!serverId) return jsonError(req, 400, "id is required");
    if (!uri) return jsonError(req, 400, "uri is required");
    if (body.scope !== undefined && body.scope !== "global" && body.scope !== "project") {
      return jsonError(req, 400, "scope must be 'global' or 'project'");
    }

    const result = await getAgentHostClient().call("mcp.readResource", {
      serverId,
      uri,
      ...(body.scope ? { scope: body.scope } : {}),
      ...(body.cwd ? { cwd: body.cwd } : {}),
    }, { timeoutMs: 60_000 });
    return NextResponse.json(result, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return jsonAgentHostError(req, error, { route: "/api/mcp/resources/read", method: "POST" });
  }
}
