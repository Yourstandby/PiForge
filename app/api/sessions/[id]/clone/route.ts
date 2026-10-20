import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server.js";
import { existsSync, readdirSync, rmSync } from "fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  getSessionsDir,
  resolveSessionPath,
  cacheSessionPath,
  invalidateSessionPathCache,
} from "../../../../../lib/session-reader.ts";
import { validateClonePayload } from "../../../../../lib/session-branch-clone.ts";
import { AgentHostError, getAgentHostClient } from "../../../../../lib/agent-host-client.ts";
import { errorMessage, getRequestId, logApiError } from "../../../../../lib/api-error.ts";

export const dynamic = "force-dynamic";

type CloneWorkspace = {
  mode: "directory" | "worktree";
  cwd: string;
  branchName?: string;
};

const GIT_WORKTREE_ERROR_CODES = new Set([
  "GIT_UNAVAILABLE",
  "NOT_GIT_REPOSITORY",
  "INVALID_BRANCH",
  "TARGET_INSIDE_REPOSITORY",
  "TARGET_EXISTS",
  "WORKTREE_CREATE_FAILED",
  "WORKTREE_CLEANUP_FAILED",
]);

class CloneCreateError extends Error {
  readonly code = "CLONE_CREATE_FAILED" as const;

  constructor() {
    super("Failed to clone session");
    this.name = "CloneCreateError";
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: unknown }).code === code
  );
}

function removeForkedSessionFiles(
  sessionsRoot: string,
  sessionId: string,
  knownSessionFile?: string
): void {
  const sessionFiles = new Set<string>();
  const errors: unknown[] = [];
  if (knownSessionFile) sessionFiles.add(knownSessionFile);

  try {
    for (const fileName of readdirSync(sessionsRoot, { recursive: true })) {
      const relativePath = typeof fileName === "string" ? fileName : fileName.toString();
      if (relativePath.endsWith(`_${sessionId}.jsonl`)) {
        sessionFiles.add(join(sessionsRoot, relativePath));
      }
    }
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) errors.push(error);
  }

  for (const sessionFile of sessionFiles) {
    try {
      rmSync(sessionFile, { force: true });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new Error(
      errors.map((error) => (error instanceof Error ? error.message : String(error))).join("; ")
    );
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const requestId = getRequestId(req);
  let cloneSessionsRoot: string | undefined;
  let cloneSessionId: string | undefined;
  let createdSessionFile: string | undefined;
  let cachedSessionId: string | undefined;
  try {
    const sessionFile = await resolveSessionPath(id);
    if (!sessionFile || !existsSync(sessionFile)) {
      return NextResponse.json(
        { error: "Session not found", errorCode: "SESSION_NOT_FOUND" },
        { status: 404, headers: { "x-request-id": requestId } }
      );
    }

    let body: unknown = {};
    try {
      const text = await req.text();
      if (text.trim().length > 0) {
        body = JSON.parse(text);
      }
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON payload", errorCode: "INVALID_JSON_PAYLOAD" },
        { status: 400, headers: { "x-request-id": requestId } }
      );
    }

    const validation = validateClonePayload(body);
    if (!validation.valid) {
      return NextResponse.json(
        {
          error: validation.error,
          ...(validation.code ? { errorCode: validation.code } : {}),
        },
        { status: 400, headers: { "x-request-id": requestId } }
      );
    }

    const sourceSm = SessionManager.open(sessionFile);
    const header = sourceSm.getHeader();
    const sourceCwd = header?.cwd || process.cwd();

    const targetCwd = validation.data.targetCwd || sourceCwd;
    const directoryWorkspace: CloneWorkspace = {
      mode: "directory",
      cwd: targetCwd,
    };
    const cloneSession = (cloneCwd: string, workspace: CloneWorkspace) => {
      cloneSessionsRoot = getSessionsDir();
      cloneSessionId = randomUUID();
      const forkedSm = SessionManager.forkFrom(
        sessionFile,
        cloneCwd,
        undefined,
        { id: cloneSessionId }
      );
      const newSessionFile = forkedSm.getSessionFile();
      if (!newSessionFile) {
        throw new CloneCreateError();
      }
      createdSessionFile = newSessionFile;

      if (validation.data.name) {
        forkedSm.appendSessionInfo(validation.data.name);
      }
      (forkedSm as unknown as { _rewriteFile?: () => void })._rewriteFile?.();

      const newSessionId = forkedSm.getSessionId();
      cacheSessionPath(newSessionId, newSessionFile);
      cachedSessionId = newSessionId;

      return NextResponse.json(
        {
          success: true,
          sessionId: newSessionId,
          sessionFile: newSessionFile,
          workspace,
        },
        { headers: { "x-request-id": requestId } }
      );
    };

    if (validation.data.workspaceMode === "worktree") {
      const targetCwd = validation.data.targetCwd;
      if (!targetCwd) {
        return NextResponse.json(
          {
            error: "targetCwd is required for a worktree clone",
            errorCode: "INVALID_TARGET_CWD",
          },
          { status: 400, headers: { "x-request-id": requestId } }
        );
      }
      // Git worktree creation, ownership markers and authorization live in the
      // Agent Host. Next only forwards the request over RPC.
      const cloned = await getAgentHostClient().call("workspace.cloneSession", {
        sessionId: id,
        sessionFile,
        sourceCwd,
        targetCwd,
        ...(validation.data.branchName ? { branchName: validation.data.branchName } : {}),
        ...(validation.data.name ? { name: validation.data.name } : {}),
      });
      return NextResponse.json(cloned, { headers: { "x-request-id": requestId } });
    }

    return cloneSession(targetCwd, directoryWorkspace);
  } catch (error) {
    if (cachedSessionId) {
      invalidateSessionPathCache(cachedSessionId);
    }
    if (cloneSessionsRoot && cloneSessionId) {
      try {
        removeForkedSessionFiles(cloneSessionsRoot, cloneSessionId, createdSessionFile);
      } catch (cleanupError) {
        logApiError({
          route: `/api/sessions/${id}/clone`,
          method: "POST",
          requestId,
          error: cleanupError,
          params: { sessionsRoot: cloneSessionsRoot, sessionId: cloneSessionId },
        });
      }
    }
    logApiError({ route: `/api/sessions/${id}/clone`, method: "POST", requestId, error });
    const hostCode = error instanceof AgentHostError ? error.code : null;
    const gitError = hostCode !== null && GIT_WORKTREE_ERROR_CODES.has(hostCode);
    const status =
      gitError || hostCode === "ACCESS_DENIED"
        ? 400
        : hostCode === "E_HOST_UNAVAILABLE" || hostCode === "E_TIMEOUT"
          ? 503
          : 500;
    return NextResponse.json(
      {
        error: errorMessage(error),
        errorCode:
          gitError
            ? hostCode
            : hostCode === "ACCESS_DENIED"
              ? "ACCESS_DENIED"
              : error instanceof CloneCreateError
                ? error.code
                : "CLONE_OPERATION_FAILED",
      },
      { status, headers: { "x-request-id": requestId } }
    );
  }
}
