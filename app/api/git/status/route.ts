import { NextResponse } from "next/server";
import { errorMessage, getRequestId, jsonError, logApiError } from "@/lib/api-error";
import { getAllowedRoots, isPathAllowed } from "@/lib/allowed-roots";
import { GitStatusError, readGitStatus } from "@/lib/git-status";

export const dynamic = "force-dynamic";

// GET /api/git/status?cwd=<absolute project dir>
export async function GET(req: Request) {
  const requestId = getRequestId(req);
  const cwd = new URL(req.url).searchParams.get("cwd");
  if (!cwd) return jsonError(req, 400, "Missing cwd");

  try {
    const allowedRoots = await getAllowedRoots();
    if (!isPathAllowed(cwd, allowedRoots)) {
      return jsonError(req, 403, "Access denied");
    }
    const result = await readGitStatus(cwd);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof GitStatusError && error.code === "NOT_GIT_REPOSITORY") {
      return NextResponse.json({ repoRoot: null, files: [], notGitRepo: true });
    }
    logApiError({ route: "/api/git/status", method: "GET", requestId, error, params: { cwd } });
    return jsonError(req, 500, errorMessage(error));
  }
}
