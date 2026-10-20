/**
 * Host-owned session clone into a Git worktree (v0.6.0 stage 9 step 1).
 *
 * All `git worktree` work happens here, never in Next:
 *   1. authorize the target path through the Host file policy,
 *   2. create the worktree with the existing ownership-marked implementation,
 *   3. fork the session into the new worktree and register it as an allowed root.
 *
 * The caller only receives metadata; it never runs Git or reads `.git`.
 */
import { randomUUID } from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  GitWorktreeError,
  withGitWorktree,
  type CreateGitWorktreeOptions,
  type GitWorktreeResult,
} from "../lib/git-worktree.ts";
import { addAllowedRoot, authorizePath } from "./allowed-roots.ts";

export interface CloneSessionToWorktreeInput {
  sessionId: string;
  sessionFile: string;
  sourceCwd: string;
  /** Absolute target, or a path relative to the source repository's parent. */
  targetCwd: string;
  branchName?: string;
  name?: string;
}

export interface WorkspaceForkResult {
  sessionId: string;
  sessionFile: string;
}

export interface CloneSessionToWorktreeResult {
  success: true;
  sessionId: string;
  sessionFile: string;
  workspace: {
    mode: "worktree";
    cwd: string;
    branchName: string;
  };
  worktree: {
    repoRoot: string;
    gitDir: string;
    head: string;
    branchOwnerToken: string;
    ownerMarkerPath?: string;
    ownerToken?: string;
  };
}

export interface WorkspaceCloneDependencies {
  /** Injected for tests; defaults to the Host-authorized policy. */
  authorizeTarget?: (target: string) => Promise<string>;
  /** Injected for tests; defaults to the ownership-marked Git implementation. */
  createWorktree?: <T>(
    options: CreateGitWorktreeOptions,
    operation: (worktree: GitWorktreeResult) => T | Promise<T>,
  ) => Promise<T>;
  /** Injected for tests; defaults to SessionManager.forkFrom. */
  forkSession?: (sessionFile: string, cwd: string, name?: string) => WorkspaceForkResult;
}

function resolveTarget(input: CloneSessionToWorktreeInput): string {
  const target = input.targetCwd.trim();
  if (!target) throw new Error("targetCwd is required for a worktree clone");
  return isAbsolute(target) ? resolve(target) : resolve(dirname(input.sourceCwd), target);
}

/** Remove a partial fork when `forkFrom` failed after creating its JSONL. */
function removePartialFork(sessionId: string, createdFile: string | null): void {
  if (createdFile) {
    try {
      rmSync(createdFile, { force: true });
    } catch {
      // best effort; the worktree cleanup still runs
    }
  }
  try {
    const root = join(getAgentDir(), "sessions");
    for (const entry of readdirSync(root, { recursive: true })) {
      const relativePath = typeof entry === "string" ? entry : entry.toString();
      if (relativePath.endsWith(`_${sessionId}.jsonl`)) {
        rmSync(join(root, relativePath), { force: true });
      }
    }
  } catch {
    // Session directory may not exist / be readable; nothing to clean.
  }
}

function forkSessionIntoWorktree(
  sessionFile: string,
  cwd: string,
  name?: string,
): WorkspaceForkResult {
  const sessionId = randomUUID();
  let fork: SessionManager | null = null;
  let createdFile: string | null = null;
  try {
    fork = SessionManager.forkFrom(sessionFile, cwd, undefined, { id: sessionId });
    createdFile = fork.getSessionFile() ?? null;
    if (!createdFile) throw new Error("Forked session has no file");
    const trimmed = name?.trim();
    if (trimmed) fork.appendSessionInfo(trimmed);
    (fork as unknown as { _rewriteFile?: () => void })._rewriteFile?.();
    return { sessionId: fork.getSessionId(), sessionFile: createdFile };
  } catch (error) {
    // Do not leave a partially written JSONL behind when the fork fails.
    removePartialFork(sessionId, createdFile);
    throw error;
  }
}

export async function cloneSessionToWorktree(
  input: CloneSessionToWorktreeInput,
  deps: WorkspaceCloneDependencies = {},
): Promise<CloneSessionToWorktreeResult> {
  if (!input.sessionId.trim()) throw new Error("sessionId is required");
  if (!input.sessionFile.trim()) throw new Error("sessionFile is required");
  if (!input.sourceCwd.trim()) throw new Error("sourceCwd is required");

  const target = resolveTarget(input);
  // `authorizePath(..., "write")` accepts a not-yet-created target as long as
  // its parent resolves inside an allowed root. This is the Host file policy,
  // not a UI-side path check.
  const authorize = deps.authorizeTarget ?? ((path) => authorizePath(path, "write"));
  const authorizedTarget = await authorize(target);

  const createWorktree = deps.createWorktree ?? withGitWorktree;
  const forkSession = deps.forkSession ?? forkSessionIntoWorktree;

  return createWorktree(
    {
      sourceCwd: input.sourceCwd,
      targetCwd: authorizedTarget,
      ...(input.branchName?.trim() ? { branchName: input.branchName.trim() } : {}),
    },
    (worktree) => {
      // The worktree is now a legitimate project root for file APIs.
      addAllowedRoot(worktree.cwd);
      const forked = forkSession(input.sessionFile, worktree.cwd, input.name);
      return {
        success: true as const,
        sessionId: forked.sessionId,
        sessionFile: forked.sessionFile,
        workspace: {
          mode: "worktree" as const,
          cwd: worktree.cwd,
          branchName: worktree.branchName,
        },
        worktree: {
          repoRoot: worktree.repoRoot,
          gitDir: worktree.gitDir,
          head: worktree.head,
          branchOwnerToken: worktree.branchOwnerToken,
          ...(worktree.ownerMarkerPath ? { ownerMarkerPath: worktree.ownerMarkerPath } : {}),
          ...(worktree.ownerToken ? { ownerToken: worktree.ownerToken } : {}),
        },
      };
    },
  );
}

export { GitWorktreeError };
