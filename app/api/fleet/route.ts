import { NextResponse } from "../../../lib/next-server-shim.ts";
import { getRequestId, jsonError } from "../../../lib/api-error.ts";
import { validateRequestOrigin } from "../../../lib/auth-policy.ts";
import { getAgentHostClient } from "../../../lib/agent-host-client.ts";
import { jsonAgentHostError } from "../../../lib/agent-host-http.ts";

export const dynamic = "force-dynamic";

/** GET /api/fleet — 常驻舰队配置 + 当前存活的舰队 Agent。 */
export async function GET(req: Request) {
  try {
    const snapshot = await getAgentHostClient().call("fleet.list", {});
    return NextResponse.json(snapshot, { headers: { "x-request-id": getRequestId(req) } });
  } catch (error) {
    return jsonAgentHostError(req, error, { route: "/api/fleet", method: "GET" });
  }
}

/**
 * POST /api/fleet — { action: "save" | "delete" | "import" | "wake" | "message" | "stop" }
 * 写入类动作都要求同源校验（与其它 Host 代理一致）。
 */
export async function POST(req: Request) {
  const originError = validateRequestOrigin(req);
  if (originError) return jsonError(req, 403, originError);
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonError(req, 400, "invalid JSON body");
  }
  const client = getAgentHostClient();
  try {
    switch (body.action) {
      case "save": {
        const result = await client.call("fleet.save", { profile: body.profile as never });
        return NextResponse.json(result, { headers: { "x-request-id": getRequestId(req) } });
      }
      case "delete": {
        const result = await client.call("fleet.delete", { id: String(body.id ?? "") });
        return NextResponse.json(result, { headers: { "x-request-id": getRequestId(req) } });
      }
      case "import": {
        const result = await client.call("fleet.import", { payload: body.payload });
        return NextResponse.json(result, { headers: { "x-request-id": getRequestId(req) } });
      }
      case "wake": {
        const result = await client.call("fleet.wake", {
          id: String(body.id ?? ""),
          ...(typeof body.cwd === "string" ? { cwd: body.cwd } : {}),
          ...(typeof body.parentSessionId === "string"
            ? { parentSessionId: body.parentSessionId }
            : {}),
        });
        return NextResponse.json(result, { headers: { "x-request-id": getRequestId(req) } });
      }
      case "message": {
        const result = await client.call("fleet.message", {
          id: String(body.id ?? ""),
          message: String(body.message ?? ""),
        });
        return NextResponse.json(result, { headers: { "x-request-id": getRequestId(req) } });
      }
      case "stop": {
        const result = await client.call("herdr.stop", { id: String(body.id ?? "") });
        return NextResponse.json(result, { headers: { "x-request-id": getRequestId(req) } });
      }
      default:
        return jsonError(req, 400, "unknown action");
    }
  } catch (error) {
    return jsonAgentHostError(req, error, { route: "/api/fleet", method: "POST" });
  }
}
