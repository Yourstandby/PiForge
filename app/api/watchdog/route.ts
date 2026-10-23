import { NextResponse } from "next/server.js";
import { getRequestId } from "../../../lib/api-error.ts";
import { getAgentHostClient } from "../../../lib/agent-host-client.ts";
import { jsonAgentHostError } from "../../../lib/agent-host-http.ts";

export const dynamic = "force-dynamic";

/**
 * GET /api/watchdog — 只读的看门狗快照（任务心跳 / 结构化通知）。
 *
 * 这条路由只做一件事：把 Host 的 `watchdog.status` 转发给 Renderer。
 * 它不写库、不写会话文件、不碰模型；禁止在这里做任何「通知模型」的动作。
 * 看门狗被关闭时 Host 返回 `{ enabled: false }`，UI 侧随即停止轮询。
 */
export async function GET(req: Request) {
  const requestId = getRequestId(req);
  try {
    const snapshot = await getAgentHostClient().call("watchdog.status", {});
    return NextResponse.json(snapshot, {
      headers: { "x-request-id": requestId, "cache-control": "no-store" },
    });
  } catch (error) {
    return jsonAgentHostError(req, error, { route: "/api/watchdog", method: "GET" });
  }
}

/**
 * POST /api/watchdog — 运行期调整停滞阈值（面板下拉框）。
 *
 * 只转发一条 `watchdog.configure`，Host 负责钳制到 [5s, 10min]。
 * 不写配置文件、不重启 Host、不触发扫描，因此不存在「改阈值导致任务被误判」的路径。
 */
export async function POST(req: Request) {
  const requestId = getRequestId(req);
  try {
    const body = (await req.json().catch(() => null)) as { stallMs?: unknown } | null;
    const stallMs = body?.stallMs;
    if (typeof stallMs !== "number" || !Number.isFinite(stallMs) || stallMs <= 0) {
      return NextResponse.json(
        { error: "stallMs must be a positive number", code: "E_INVALID_PARAMS" },
        { status: 400, headers: { "x-request-id": requestId, "cache-control": "no-store" } },
      );
    }
    const config = await getAgentHostClient().call("watchdog.configure", { stallMs });
    return NextResponse.json(config, {
      headers: { "x-request-id": requestId, "cache-control": "no-store" },
    });
  } catch (error) {
    return jsonAgentHostError(req, error, { route: "/api/watchdog", method: "POST" });
  }
}
