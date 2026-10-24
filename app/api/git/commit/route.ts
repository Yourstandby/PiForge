import { NextResponse } from "../../../../lib/next-server-shim.ts";
import { errorMessage, getRequestId, jsonError, logApiError } from "../../../../lib/api-error.ts";
import { authorizeHostPath, hostFileAccessError } from "../../../../lib/host-files.ts";
import { GitCommitError, GitStatusError, commitAllChanges } from "../../../../lib/git-status.ts";

export const dynamic = "force-dynamic";

// POST /api/git/commit - { cwd, message }
// Stages everything (git add -A) and commits with the given message.
export async function POST(req: Request) {
  const requestId = getRequestId(req);
  try {
    const body = (await req.json()) as { cwd?: string; message?: string };
    const cwd = body.cwd;
    const message = typeof body.message === "string" ? body.message : "";
    if (!cwd) return jsonError(req, 400, "Missing cwd");

    try {
      await authorizeHostPath(cwd, "list");
    } catch (error) {
      return hostFileAccessError(req, error, "/api/git/commit", "POST");
    }

    const result = await commitAllChanges(cwd, message);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof GitCommitError) {
      // Empty message / not a repo = bad request; nothing staged or git's own
      // refusal (hooks, identity) = conflict, with git's output passed through.
      const status = error.code === "EMPTY_MESSAGE" || error.code === "NOT_GIT_REPOSITORY" ? 400 : 409;
      return NextResponse.json(
        { error: error.message, errorCode: error.code, output: error.output },
        { status, headers: { "x-request-id": requestId } },
      );
    }
    if (error instanceof GitStatusError && error.code === "NOT_GIT_REPOSITORY") {
      return jsonError(req, 400, "Not a Git repository");
    }
    logApiError({ route: "/api/git/commit", method: "POST", requestId, error });
    return jsonError(req, 500, errorMessage(error));
  }
}
