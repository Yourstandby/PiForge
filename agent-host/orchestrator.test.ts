import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { OrchestratorWorkerConfig } from "./orchestrator-protocol.ts";
import {
  listOrchestratorTasks,
  resetOrchestratorForTest,
  spawnOrchestratorTask,
  stopOrchestratorTask,
  type LaunchOrchestratorWorker,
  type WorkerLaunchHandlers,
} from "./orchestrator.ts";

function fakeWorktree() {
  return async <T>(
    options: { sourceCwd: string; targetCwd: string; branchName?: string },
    operation: (worktree: {
      cwd: string;
      branchName: string;
      repoRoot: string;
      gitDir: string;
      head: string;
      branchOwnerToken: string;
    }) => T | Promise<T>,
  ): Promise<T> => {
    mkdirSync(options.targetCwd, { recursive: true });
    return operation({
      cwd: options.targetCwd,
      branchName: options.branchName ?? "piforge/test",
      repoRoot: options.sourceCwd,
      gitDir: join(options.sourceCwd, ".git", "worktrees", "fake"),
      head: "a".repeat(40),
      branchOwnerToken: "owner",
    });
  };
}

test("spawns a worker in its own worktree and records finished evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "piforge-orch-"));
  let handlers: WorkerLaunchHandlers | null = null;
  let config: OrchestratorWorkerConfig | null = null;
  const launch: LaunchOrchestratorWorker = (nextConfig, nextHandlers) => {
    config = nextConfig;
    handlers = nextHandlers;
    return { pid: 4242, kill: () => {} };
  };
  try {
    const pending = await spawnOrchestratorTask({
      cwd: "D:/repo",
      task: "Implement the auth module and run tests.",
      name: "auth-worker",
      parentSessionId: "main-session",
    }, {
      worktreeRoot: join(root, "trees"),
      authorizeTarget: async (path) => path,
      createWorktree: fakeWorktree(),
      launchWorker: launch,
    });
    assert.equal(pending.status, "starting");
    assert.equal(pending.parentSessionId, "main-session");
    assert.equal(pending.workerPid, 4242);
    const captured = config as OrchestratorWorkerConfig | null;
    assert.ok(captured);
    assert.equal(captured.task, "Implement the auth module and run tests.");
    assert.equal(captured.parentSessionId, "main-session");
    assert.ok(captured.cwd.endsWith(pending.id.slice(0, 8)));

    handlers!.onMessage({ type: "ready", pid: 4242 });
    handlers!.onMessage({ type: "progress", text: "working" });
    handlers!.onMessage({
      type: "tool",
      call: { id: "t1", name: "read", status: "ok", startedAt: 1, endedAt: 2 },
    });
    handlers!.onMessage({
      type: "finished",
      ok: true,
      output: "Implemented auth. Tests: 5 passed.",
      toolCalls: [{ id: "t1", name: "read", status: "ok", startedAt: 1, endedAt: 2 }],
      verification: { verified: true, reason: "ok", evidence: ["read"], checkedAt: 2 },
      filesChanged: ["M src/auth.ts"],
    });

    const [task] = listOrchestratorTasks();
    assert.equal(task.status, "exited");
    assert.equal(task.verified, true);
    assert.equal(task.output, "Implemented auth. Tests: 5 passed.");
    assert.deepEqual(task.filesChanged, ["M src/auth.ts"]);
    assert.ok(task.finishedAt);
  } finally {
    resetOrchestratorForTest();
    rmSync(root, { recursive: true, force: true });
  }
});

test("stop moves a running worker through stopping to stopped", async () => {
  const root = mkdtempSync(join(tmpdir(), "piforge-orch-stop-"));
  let handlers: WorkerLaunchHandlers | null = null;
  let killed = false;
  try {
    const task = await spawnOrchestratorTask({
      cwd: "D:/repo",
      task: "Long task",
      parentSessionId: "main",
    }, {
      worktreeRoot: join(root, "trees"),
      authorizeTarget: async (path) => path,
      createWorktree: fakeWorktree(),
      launchWorker: (_config, nextHandlers) => {
        handlers = nextHandlers;
        return { pid: 777, kill: () => { killed = true; } };
      },
    });
    handlers!.onMessage({ type: "ready", pid: 777 });
    assert.equal(listOrchestratorTasks()[0].status, "running");
    assert.equal(await stopOrchestratorTask(task.id), true);
    assert.equal(killed, true);
    assert.equal(listOrchestratorTasks()[0].status, "stopping");
    handlers!.onExit(null, "SIGTERM");
    assert.equal(listOrchestratorTasks()[0].status, "stopped");
  } finally {
    resetOrchestratorForTest();
    rmSync(root, { recursive: true, force: true });
  }
});

test("worker failure is surfaced as crashed with the error text", async () => {
  const root = mkdtempSync(join(tmpdir(), "piforge-orch-fail-"));
  try {
    await spawnOrchestratorTask({
      cwd: "D:/repo",
      task: "Fail",
      parentSessionId: "main",
    }, {
      worktreeRoot: join(root, "trees"),
      authorizeTarget: async (path) => path,
      createWorktree: fakeWorktree(),
      launchWorker: () => ({ pid: 12, kill: () => {} }),
    });
    const [task] = listOrchestratorTasks();
    assert.equal(task.status, "starting");
  } finally {
    resetOrchestratorForTest();
    rmSync(root, { recursive: true, force: true });
  }
});
