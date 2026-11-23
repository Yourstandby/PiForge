import { NextResponse } from "../../../lib/next-server-shim.ts";
import { AgentHostError, getAgentHostClient } from "../../../lib/agent-host-client.ts";
import { errorMessage, getRequestId, logApiError } from "../../../lib/api-error.ts";
import { validateRequestOrigin } from "../../../lib/auth-policy.ts";

export const dynamic = "force-dynamic";

function hostError(error: unknown): Response {
  if (error instanceof AgentHostError) {
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status: error.code === "E_INVALID_PARAMS" ? 400 : 503 },
    );
  }
  return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
}

export async function GET() {
  try {
    return NextResponse.json(await getAgentHostClient().call("orchestrator.list", {}));
  } catch (error) {
    return hostError(error);
  }
}

export async function POST(req: Request) {
  const requestId = getRequestId(req);
  try {
    const body = (await req.json()) as {
      action?: unknown;
      id?: unknown;
      name?: unknown;
      task?: unknown;
      cwd?: unknown;
      branchName?: unknown;
    };
    // 面板手动派生 worker（与模型 orchestrator_spawn 同一通道）。
    if (body.action === "spawn") {
      const originError = validateRequestOrigin(req);
      if (originError) return NextResponse.json({ error: originError }, { status: 403 });
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const task = typeof body.task === "string" ? body.task.trim() : "";
      const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
      if (!task || !cwd) {
        return NextResponse.json({ error: "action=spawn requires task and cwd" }, { status: 400 });
      }
      const branchName = typeof body.branchName === "string" ? body.branchName.trim() : "";
      const data = await getAgentHostClient().call("orchestrator.spawn", {
        task,
        cwd,
        parentSessionId: "desktop",
        ...(name ? { name } : {}),
        ...(branchName ? { branchName } : {}),
      });
      return NextResponse.json(data, { headers: { "x-request-id": requestId } });
    }
    if (body.action !== "stop" || typeof body.id !== "string") {
      return NextResponse.json({ error: "action=stop and id are required" }, { status: 400 });
    }
    const data = await getAgentHostClient().call("orchestrator.stop", { id: body.id });
    return NextResponse.json(data, { headers: { "x-request-id": requestId } });
  } catch (error) {
    logApiError({ route: "/api/orchestrator", method: "POST", requestId, error });
    return hostError(error);
  }
}
