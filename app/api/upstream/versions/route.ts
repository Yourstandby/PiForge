import { NextResponse } from "../../../../lib/next-server-shim.ts";
import { errorMessage, getRequestId, jsonError, logApiError } from "../../../../lib/api-error.ts";
import { getPiCoreVersionList } from "../../../../lib/upstream-version.ts";

export const dynamic = "force-dynamic";

// GET /api/upstream/versions            → 本地版本 + 可切换版本列表（30 分钟缓存）
// GET /api/upstream/versions?force=1    → 跳过缓存重新查询
export async function GET(req: Request) {
  const requestId = getRequestId(req);
  try {
    const { searchParams } = new URL(req.url);
    const force = searchParams.get("force") === "1";
    const list = await getPiCoreVersionList(force);
    return NextResponse.json(list, { headers: { "x-request-id": requestId } });
  } catch (error) {
    logApiError({ route: "/api/upstream/versions", method: "GET", requestId, error });
    return jsonError(req, 500, errorMessage(error));
  }
}
