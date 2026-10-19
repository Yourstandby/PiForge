import { NextResponse } from "next/server";
import { errorMessage, getRequestId, jsonError, logApiError } from "@/lib/api-error";
import { getAllowedRoots, isPathAllowed } from "@/lib/allowed-roots";
import { buildFileIndex, searchFileIndex } from "@/lib/file-index";

export const dynamic = "force-dynamic";

// GET /api/file-index?cwd=<abs>&q=<query> - flat file list for `@` mentions
export async function GET(req: Request) {
  const requestId = getRequestId(req);
  const params = new URL(req.url).searchParams;
  const cwd = params.get("cwd");
  const query = params.get("q") ?? "";
  if (!cwd) return jsonError(req, 400, "Missing cwd");

  try {
    const allowedRoots = await getAllowedRoots();
    if (!isPathAllowed(cwd, allowedRoots)) {
      return jsonError(req, 403, "Access denied");
    }
    const { entries, truncated } = await buildFileIndex(cwd);
    const matches = searchFileIndex(entries, query, 20);
    return NextResponse.json({ matches, truncated });
  } catch (error) {
    logApiError({ route: "/api/file-index", method: "GET", requestId, error, params: { cwd } });
    return jsonError(req, 500, errorMessage(error));
  }
}
