import { NextResponse } from "../../../../lib/next-server-shim.ts";
import { errorMessage, getRequestId, jsonError, logApiError } from "../../../../lib/api-error.ts";
import { authorizeHostPath, hostFileAccessError } from "../../../../lib/host-files.ts";
import { GitStatusError, readGitDiff } from "../../../../lib/git-status.ts";

export const dynamic = "force-dynamic";

// GET /api/git/diff?cwd=<absolute project dir>&path=<cwd-relative file>
export async function GET(req: Request) {
  const requestId = getRequestId(req);
  const params = new URL(req.url).searchParams;
  const cwd = params.get("cwd");
  const target = params.get("path");
  if (!cwd || !target) return jsonError(req, 400, "Missing cwd or path");

  try {
    try {
      await authorizeHostPath(cwd, "list");
    } catch (error) {
      return hostFileAccessError(req, error, "/api/git/diff", "GET");
    }
    const diff = await readGitDiff(cwd, target);
    return NextResponse.json({ diff });
  } catch (error) {
    if (error instanceof GitStatusError && error.code === "PATH_OUTSIDE_CWD") {
      return jsonError(req, 403, error.message);
    }
    if (error instanceof GitStatusError && error.code === "NOT_GIT_REPOSITORY") {
      return jsonError(req, 400, "Not a Git repository");
    }
    logApiError({ route: "/api/git/diff", method: "GET", requestId, error, params: { cwd } });
    return jsonError(req, 500, errorMessage(error));
  }
}
