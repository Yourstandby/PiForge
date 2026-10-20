import { NextResponse } from "next/server.js";
import { getRequestId, jsonError } from "../../../../lib/api-error.ts";
import { validateRequestOrigin } from "../../../../lib/auth-policy.ts";
import { getAgentHostClient } from "../../../../lib/agent-host-client.ts";
import { jsonAgentHostError } from "../../../../lib/agent-host-http.ts";
import type { McpScope } from "../../../../contract/domains/mcp.ts";

export const dynamic = "force-dynamic";

type AuthAction = "login" | "cancel" | "logout" | "refresh";

function parseScope(value: unknown): McpScope | undefined | null {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "global" || value === "project") return value;
  return null;
}

/** GET /api/mcp/auth?id=&scope=&cwd= — stored OAuth state for one server. */
export async function GET(req: Request) {
  const requestId = getRequestId(req);
  try {
    const { searchParams } = new URL(req.url);
    const serverId = searchParams.get("id")?.trim();
    if (!serverId) return jsonError(req, 400, "id is required");
    const scope = parseScope(searchParams.get("scope"));
    if (scope === null) return jsonError(req, 400, "scope must be 'global' or 'project'");
    const cwd = searchParams.get("cwd") ?? undefined;

    const auth = await getAgentHostClient().call("mcp.authStatus", {
      serverId,
      ...(scope ? { scope } : {}),
      ...(cwd ? { cwd } : {}),
    });
    return NextResponse.json(auth, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return jsonAgentHostError(req, error, { route: "/api/mcp/auth", method: "GET" });
  }
}

/** POST /api/mcp/auth — start/cancel OAuth sign-in, sign out, or refresh credentials. */
export async function POST(req: Request) {
  const requestId = getRequestId(req);
  const originError = validateRequestOrigin(req);
  if (originError) return jsonError(req, 403, originError);
  try {
    const body = (await req.json()) as {
      action?: AuthAction;
      id?: string;
      scope?: McpScope;
      cwd?: string;
      loginId?: string;
    };
    const action = body?.action;
    if (action !== "login" && action !== "cancel" && action !== "logout" && action !== "refresh") {
      return jsonError(req, 400, "action must be 'login', 'cancel', 'logout' or 'refresh'");
    }

    if (action === "cancel") {
      const loginId = body.loginId?.trim();
      if (!loginId) return jsonError(req, 400, "loginId is required");
      const result = await getAgentHostClient().call("mcp.cancelLogin", { loginId });
      return NextResponse.json(result, { headers: { "x-request-id": requestId } });
    }

    const serverId = body.id?.trim();
    if (!serverId) return jsonError(req, 400, "id is required");
    const scope = parseScope(body.scope);
    if (scope === null) return jsonError(req, 400, "scope must be 'global' or 'project'");
    const ref = {
      serverId,
      ...(scope ? { scope } : {}),
      ...(body.cwd ? { cwd: body.cwd } : {}),
    };

    if (action === "login") {
      const login = await getAgentHostClient().call("mcp.login", ref, { timeoutMs: 60_000 });
      return NextResponse.json({ ...login, serverId }, { headers: { "x-request-id": requestId } });
    }
    if (action === "logout") {
      const result = await getAgentHostClient().call("mcp.logout", ref);
      return NextResponse.json(result, { headers: { "x-request-id": requestId } });
    }
    const auth = await getAgentHostClient().call("mcp.refreshAuth", ref, { timeoutMs: 60_000 });
    return NextResponse.json(auth, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return jsonAgentHostError(req, error, { route: "/api/mcp/auth", method: "POST" });
  }
}
