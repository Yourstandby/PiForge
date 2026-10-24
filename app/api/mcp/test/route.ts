import { NextResponse } from "../../../../lib/next-server-shim.ts";
import { getRequestId, jsonError } from "../../../../lib/api-error.ts";
import { validateRequestOrigin } from "../../../../lib/auth-policy.ts";
import { getAgentHostClient } from "../../../../lib/agent-host-client.ts";
import { jsonAgentHostError } from "../../../../lib/agent-host-http.ts";
import type { McpConnectionConfig, McpScope } from "../../../../contract/domains/mcp.ts";

export const dynamic = "force-dynamic";

/**
 * Connection probe. Runs entirely in the Agent Host; the Next.js process never
 * opens an MCP transport. Accepts either a saved server (`serverId`) or the
 * unsaved form fields from the settings panel.
 */
export async function POST(req: Request) {
  const requestId = getRequestId(req);
  const originError = validateRequestOrigin(req);
  if (originError) {
    return jsonError(req, 403, originError);
  }
  try {
    const body = (await req.json()) as {
      serverId?: string;
      scope?: McpScope;
      cwd?: string;
      connection?: McpConnectionConfig;
      transport?: McpConnectionConfig["transport"];
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      url?: string;
      headers?: Record<string, string>;
    };

    if (body?.serverId) {
      if (body.scope !== undefined && body.scope !== "global" && body.scope !== "project") {
        return jsonError(req, 400, "scope must be 'global' or 'project'");
      }
      const report = await getAgentHostClient().call("mcp.probe", {
        serverId: body.serverId,
        ...(body.scope ? { scope: body.scope } : {}),
        ...(body.cwd ? { cwd: body.cwd } : {}),
      }, { timeoutMs: 60_000 });
      return NextResponse.json(
        {
          success: report.ok,
          message: report.message,
          toolsCount: report.toolsCount,
          resources: report.resources,
          resourceTemplates: report.resourceTemplates,
          authRequired: report.authRequired,
          elapsedMs: report.elapsedMs,
        },
        { headers: { "x-request-id": requestId } },
      );
    }

    const connection: McpConnectionConfig = body?.connection ?? {
      transport: body?.transport,
      command: body?.command,
      args: body?.args,
      env: body?.env,
      url: body?.url,
      headers: body?.headers,
      cwd: body?.cwd,
    };
    if (!connection.command?.trim() && !connection.url?.trim()) {
      return jsonError(req, 400, "serverId or a connection (command/url) is required");
    }
    const report = await getAgentHostClient().call("mcp.probe", {
      connection,
      ...(body?.cwd ? { cwd: body.cwd } : {}),
    }, { timeoutMs: 60_000 });
    return NextResponse.json(
      {
        success: report.ok,
        message: report.message,
        toolsCount: report.toolsCount,
        resources: report.resources,
        resourceTemplates: report.resourceTemplates,
        authRequired: report.authRequired,
        elapsedMs: report.elapsedMs,
      },
      { headers: { "x-request-id": requestId } },
    );
  } catch (error) {
    return jsonAgentHostError(req, error, { route: "/api/mcp/test", method: "POST" });
  }
}
