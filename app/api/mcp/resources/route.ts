import { NextResponse } from "../../../../lib/next-server-shim.ts";
import { getRequestId, jsonError } from "../../../../lib/api-error.ts";
import { getAgentHostClient } from "../../../../lib/agent-host-client.ts";
import { jsonAgentHostError } from "../../../../lib/agent-host-http.ts";
import type { McpScope } from "../../../../contract/domains/mcp.ts";

export const dynamic = "force-dynamic";

function readScope(value: string | null): McpScope | undefined | null {
  if (value === null || value === "") return undefined;
  if (value === "global" || value === "project") return value;
  return null;
}

/** List a server's MCP resources and resource templates (host-side connection). */
export async function GET(req: Request) {
  const requestId = getRequestId(req);
  try {
    const { searchParams } = new URL(req.url);
    const serverId = searchParams.get("id")?.trim();
    if (!serverId) return jsonError(req, 400, "id is required");
    const scope = readScope(searchParams.get("scope"));
    if (scope === null) return jsonError(req, 400, "scope must be 'global' or 'project'");
    const cwd = searchParams.get("cwd") ?? undefined;

    const result = await getAgentHostClient().call("mcp.resources", {
      serverId,
      ...(scope ? { scope } : {}),
      ...(cwd ? { cwd } : {}),
    }, { timeoutMs: 60_000 });
    return NextResponse.json(result, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return jsonAgentHostError(req, error, { route: "/api/mcp/resources", method: "GET" });
  }
}
