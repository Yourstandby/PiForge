import { NextResponse } from "../../../../lib/next-server-shim.ts";
import { errorMessage, getRequestId, jsonError, logApiError } from "../../../../lib/api-error.ts";
import { authorizeHostPath, hostFileAccessError } from "../../../../lib/host-files.ts";
import { GitStatusError, readGitSnapshot } from "../../../../lib/git-status.ts";

export const dynamic = "force-dynamic";

// GET /api/git/status?cwd=<absolute project dir>
export async function GET(req: Request) {
  const requestId = getRequestId(req);
  const cwd = new URL(req.url).searchParams.get("cwd");
  if (!cwd) return jsonError(req, 400, "Missing cwd");

  try {
    try {
      await authorizeHostPath(cwd, "list", cwd);
    } catch (error) {
      return hostFileAccessError(req, error, "/api/git/status", "GET");
    }
    // status + branch 合成一次快照：共用 3s 缓存，branch 复用 status 已算出的
    // repoRoot，省掉一次 `git rev-parse --show-toplevel`（实测每次 228ms）。
    const snapshot = await readGitSnapshot(cwd);
    return NextResponse.json(snapshot);
  } catch (error) {
    if (error instanceof GitStatusError && error.code === "NOT_GIT_REPOSITORY") {
      return NextResponse.json({ repoRoot: null, files: [], branch: null, notGitRepo: true });
    }
    logApiError({ route: "/api/git/status", method: "GET", requestId, error, params: { cwd } });
    return jsonError(req, 500, errorMessage(error));
  }
}
