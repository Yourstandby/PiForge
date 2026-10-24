import { NextResponse } from "../../../../../lib/next-server-shim.ts";
import { getAgentHostClient } from "../../../../../lib/agent-host-client.ts";
import { jsonAgentHostError } from "../../../../../lib/agent-host-http.ts";
import { jsonError } from "../../../../../lib/api-error.ts";
import { validateRequestOrigin } from "../../../../../lib/auth-policy.ts";

export const dynamic = "force-dynamic";

/** 允许的介入动作：极简询问 / 深度诊断 / 强制跳过（Host 会再校验一次）。 */
const ALLOWED_ACTIONS = ["skip", "ask", "ask_brief"] as const;

/**
 * POST /api/agent/[id]/intervene — 人工介入（强制跳过 / 极简询问 / 深度诊断）。
 *
 * 只做三件事：校验入参、转发到 Host 的 `agent.intervene`、原样回传结果。
 * 指令注入与看门狗重置都发生在 Host（复用既有 steer / prompt / follow-up 队列），
 * Next 侧不缓存、不重放、不新增任何模型调用。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const originError = validateRequestOrigin(req);
  if (originError) return jsonError(req, 403, originError);

  const { id } = await params;
  const sessionId = id?.trim();
  if (!sessionId) return jsonError(req, 400, "sessionId is required");

  let actionType: unknown;
  try {
    const body = (await req.json()) as { actionType?: unknown };
    actionType = body?.actionType;
  } catch {
    return jsonError(req, 400, "invalid JSON body");
  }
  if (actionType !== "skip" && actionType !== "ask" && actionType !== "ask_brief") {
    return jsonError(req, 400, `actionType must be one of: ${ALLOWED_ACTIONS.join(", ")}`);
  }

  try {
    const result = await getAgentHostClient().call("agent.intervene", {
      sessionId,
      actionType,
    });
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return jsonAgentHostError(req, error, { route: "/api/agent/[id]/intervene", method: "POST" });
  }
}
