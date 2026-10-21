import { NextResponse } from "next/server";
import { errorMessage, getRequestId, jsonError, logApiError } from "@/lib/api-error";
import { getUpstreamVersionStatus } from "@/lib/upstream-version";

export const dynamic = "force-dynamic";

// GET /api/upstream            → 本地版本 + 缓存的最新版本（30 分钟）
// GET /api/upstream?force=1    → 跳过缓存重新查询
export async function GET(req: Request) {
  const requestId = getRequestId(req);
  try {
    const { searchParams } = new URL(req.url);
    const force = searchParams.get("force") === "1";
    const status = await getUpstreamVersionStatus(force);
    return NextResponse.json(status, { headers: { "x-request-id": requestId } });
  } catch (error) {
    logApiError({ route: "/api/upstream", method: "GET", requestId, error });
    return jsonError(req, 500, errorMessage(error));
  }
}
