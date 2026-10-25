import { NextResponse } from "../../../../lib/next-server-shim.ts";
import { setHostActiveScope } from "../../../../lib/host-files.ts";
import { errorMessage, getRequestId, jsonError, logApiError } from "../../../../lib/api-error.ts";

export const dynamic = "force-dynamic";

/**
 * 上报「当前项目」给 Agent Host。
 *
 * 项目隔离（desktop-settings 的 `projectIsolation`，默认关）开启时，Host 的
 * `files.authorize` 只放行这个目录内的路径；关着的时候这次上报纯属顺手记住，
 * 不产生任何限制 —— 策略仍然完全由 Host 持有，Next 只提供上下文。
 */
export async function POST(req: Request) {
  const requestId = getRequestId(req);
  try {
    const body = (await req.json().catch(() => ({}))) as { cwd?: string | null };
    const cwd = typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : null;
    const ok = await setHostActiveScope(cwd);
    return NextResponse.json({ cwd, delivered: ok }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    logApiError({ route: "/api/files/scope", method: "POST", requestId, error });
    return jsonError(req, 500, errorMessage(error));
  }
}
