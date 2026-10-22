import { NextResponse } from "next/server";
import { listSessionsPage, SESSION_PAGE_SIZE } from "@/lib/session-reader";
import { errorMessage, getRequestId, jsonError, logApiError } from "@/lib/api-error";

/**
 * GET /api/sessions?offset=0&limit=20&keep=<sessionId>
 *
 * 分页返回会话列表：只读当前窗口内的 jsonl（首屏 20 个，之后按批追加），
 * 其余会话只做 stat 排序，不再全量扫描历史。
 */
export async function GET(req: Request) {
  const requestId = getRequestId(req);
  try {
    const params = new URL(req.url).searchParams;
    const limitParam = Number.parseInt(params.get("limit") ?? "", 10);
    const offsetParam = Number.parseInt(params.get("offset") ?? "", 10);
    const page = await listSessionsPage({
      limit: Number.isFinite(limitParam) && limitParam > 0 ? limitParam : SESSION_PAGE_SIZE,
      offset: Number.isFinite(offsetParam) && offsetParam > 0 ? offsetParam : 0,
      keep: params.get("keep"),
    });
    return NextResponse.json(page);
  } catch (error) {
    logApiError({ route: "/api/sessions", method: "GET", requestId, error });
    return jsonError(req, 500, errorMessage(error));
  }
}
