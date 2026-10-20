import { NextResponse } from "next/server";
import { errorMessage, getRequestId, jsonError, logApiError } from "@/lib/api-error";
import { authorizeHostPath, hostFileAccessError } from "@/lib/host-files";
import { GitStatusError, readGitBranch, readGitStatus } from "@/lib/git-status";

export const dynamic = "force-dynamic";

// GET /api/git/status?cwd=<absolute project dir>
export async function GET(req: Request) {
  const requestId = getRequestId(req);
  const cwd = new URL(req.url).searchParams.get("cwd");
  if (!cwd) return jsonError(req, 400, "Missing cwd");

  try {
    try {
      await authorizeHostPath(cwd, "list");
    } catch (error) {
      return hostFileAccessError(req, error, "/api/git/status", "GET");
    }
    const result = await readGitStatus(cwd);
    // Branch name is best-effort: a detached HEAD must not fail the listing.
    const branch = await readGitBranch(cwd);
    return NextResponse.json({ ...result, branch });
  } catch (error) {
    if (error instanceof GitStatusError && error.code === "NOT_GIT_REPOSITORY") {
      return NextResponse.json({ repoRoot: null, files: [], branch: null, notGitRepo: true });
    }
    logApiError({ route: "/api/git/status", method: "GET", requestId, error, params: { cwd } });
    return jsonError(req, 500, errorMessage(error));
  }
}
