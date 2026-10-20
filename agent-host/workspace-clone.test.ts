import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  cloneSessionToWorktree,
  type WorkspaceCloneDependencies,
} from "./workspace-clone.ts";
import { getAllowedRoots } from "./allowed-roots.ts";
import type { GitWorktreeResult } from "../lib/git-worktree.ts";

function fakeWorktree(target: string): GitWorktreeResult {
  return {
    cwd: target,
    branchName: "pi-agent/clone",
    repoRoot: "/repo",
    gitDir: "/repo/.git/worktrees/clone",
    head: "a".repeat(40),
    branchOwnerToken: "owner-token",
    ownerMarkerPath: "/repo/.git/worktrees/clone/pi-agent-desktop-worktree-owner",
    ownerToken: "marker-token",
  };
}

function deps(overrides: Partial<WorkspaceCloneDependencies> = {}): WorkspaceCloneDependencies {
  return {
    authorizeTarget: async (target) => target,
    createWorktree: async (options, operation) => {
      assert.equal(options.sourceCwd, "/repo");
      assert.equal(options.targetCwd, resolve("/worktrees/clone"));
      assert.equal(options.branchName, "pi-agent/clone");
      return operation(fakeWorktree(String(options.targetCwd)));
    },
    forkSession: () => ({ sessionId: "cloned-session", sessionFile: "/agent/sessions/cloned.jsonl" }),
    ...overrides,
  };
}

const input = {
  sessionId: "source-session",
  sessionFile: "/agent/sessions/source.jsonl",
  sourceCwd: "/repo",
  targetCwd: "/worktrees/clone",
  branchName: "pi-agent/clone",
  name: "Worktree Clone",
};

test("authorizes the target, creates the worktree and forks the session", async () => {
  let authorized: string | null = null;
  let forkedCwd: string | null = null;
  let forkedName: string | undefined;
  const result = await cloneSessionToWorktree(input, deps({
    authorizeTarget: async (target) => {
      authorized = target;
      return target;
    },
    forkSession: (sessionFile, cwd, name) => {
      assert.equal(sessionFile, input.sessionFile);
      forkedCwd = cwd;
      forkedName = name;
      return { sessionId: "cloned-session", sessionFile: "/agent/sessions/cloned.jsonl" };
    },
  }));

  assert.equal(authorized, resolve("/worktrees/clone"));
  assert.equal(forkedCwd, resolve("/worktrees/clone"));
  assert.equal(forkedName, "Worktree Clone");
  assert.equal(result.success, true);
  assert.equal(result.sessionId, "cloned-session");
  assert.equal(result.workspace.mode, "worktree");
  assert.equal(result.workspace.branchName, "pi-agent/clone");
  assert.equal(result.worktree.branchOwnerToken, "owner-token");
  assert.equal(result.worktree.ownerMarkerPath, fakeWorktree(resolve("/worktrees/clone")).ownerMarkerPath);
  const roots = await getAllowedRoots();
  assert.ok(roots.has(resolve("/worktrees/clone")), "worktree must become an allowed root");
});

test("resolves relative targets against the source repository parent", async () => {
  const target = join(mkdtempSync(join(tmpdir(), "pi-workspace-clone-")), "clone");
  try {
    let authorized: string | null = null;
    await cloneSessionToWorktree(
      { ...input, sourceCwd: join(target, "..", "repo"), targetCwd: "clone" },
      deps({
        authorizeTarget: async (value) => {
          authorized = value;
          return value;
        },
        createWorktree: async (_options, operation) => operation(fakeWorktree(target)),
        forkSession: () => ({ sessionId: "s", sessionFile: "/agent/s.jsonl" }),
      }),
    );
    assert.equal(authorized, resolve(target));
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("does not fork when authorization or worktree creation fails", async () => {
  let forked = false;
  await assert.rejects(
    () =>
      cloneSessionToWorktree(input, deps({
        authorizeTarget: async () => {
          throw new Error("denied");
        },
      })),
    /denied/,
  );
  assert.equal(forked, false);

  await assert.rejects(
    () =>
      cloneSessionToWorktree(input, deps({
        createWorktree: async () => {
          throw new Error("git failed");
        },
        forkSession: () => {
          forked = true;
          return { sessionId: "s", sessionFile: "/agent/s.jsonl" };
        },
      })),
    /git failed/,
  );
  assert.equal(forked, false);
});

test("requires an explicit target and a session file", async () => {
  await assert.rejects(
    () => cloneSessionToWorktree({ ...input, targetCwd: "  " }, deps()),
    /targetCwd is required/,
  );
  await assert.rejects(
    () => cloneSessionToWorktree({ ...input, sessionFile: "" }, deps()),
    /sessionFile is required/,
  );
});
