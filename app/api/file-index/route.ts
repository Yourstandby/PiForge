import { NextResponse } from "next/server";
import { errorMessage, getRequestId, jsonError, logApiError } from "@/lib/api-error";
import { authorizeHostPath, hostFileAccessError } from "@/lib/host-files";
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
    try {
      await authorizeHostPath(cwd, "list");
    } catch (error) {
      return hostFileAccessError(req, error, "/api/file-index", "GET");
    }
    const { entries, truncated } = await buildFileIndex(cwd);
    const matches = searchFileIndex(entries, query, 20);
    return NextResponse.json({ matches, truncated });
  } catch (error) {
    logApiError({ route: "/api/file-index", method: "GET", requestId, error, params: { cwd } });
    return jsonError(req, 500, errorMessage(error));
  }
}
