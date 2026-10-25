import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./sdk-adapter.ts";
import {
  SessionBranchError,
  getSessionBranches,
  isSessionFilePath,
  switchSessionBranch,
} from "./session-branches.ts";
import {
  applyPendingSessionLeaf,
  clearPendingSessionLeaves,
  hasPendingSessionLeaf,
} from "./session-branch-state.ts";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

function assistant(text: string) {
  return {
    role: "assistant" as const,
    api: "openai-completions",
    provider: "fixture",
    model: "fixture",
    content: [{ type: "text" as const, text }],
    stopReason: "stop" as const,
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function createFixture() {
  const dir = mkdtempSync(join(tmpdir(), "pi-session-branches-"));
  const previous = process.env[AGENT_DIR_ENV];
  process.env[AGENT_DIR_ENV] = join(dir, "agent");
  clearPendingSessionLeaves();
  const cwd = join(dir, "project");
  const sessionDir = join(dir, "agent", "sessions", "project");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  const manager = SessionManager.create(cwd, sessionDir);
  const ids: string[] = [];
  ids.push(manager.appendMessage({ role: "user", content: "first prompt", timestamp: Date.now() } as never));
  ids.push(manager.appendMessage(assistant("first answer") as never));
  ids.push(manager.appendMessage({ role: "user", content: "second prompt", timestamp: Date.now() } as never));
  ids.push(manager.appendMessage(assistant("second answer") as never));
  const filePath = manager.getSessionFile();
  assert.ok(filePath);
  const sessionId = manager.getSessionId();
  // Add a parallel branch under the first assistant message.
  manager.branch(ids[1]);
  ids.push(manager.appendMessage({ role: "user", content: "alternative prompt", timestamp: Date.now() } as never));
  ids.push(manager.appendMessage(assistant("alternative answer") as never));
  return {
    dir,
    cwd,
    sessionId,
    filePath,
    ids,
    manager,
    cleanup: () => {
      clearPendingSessionLeaves();
      if (previous === undefined) delete process.env[AGENT_DIR_ENV];
      else process.env[AGENT_DIR_ENV] = previous;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("session files under the agent sessions dir are accepted", () => {
  const fixture = createFixture();
  try {
    assert.equal(isSessionFilePath(fixture.filePath), true);
    assert.equal(isSessionFilePath(join(fixture.dir, "elsewhere.jsonl")), false);
    assert.equal(isSessionFilePath(join(fixture.filePath, "..", "x.txt")), false);
    assert.equal(isSessionFilePath(""), false);
  } finally {
    fixture.cleanup();
  }
});

test("getSessionBranches exposes the JSONL tree with per-node leaves", async () => {
  const fixture = createFixture();
  try {
    const branches = await getSessionBranches({
      sessionId: fixture.sessionId,
      filePath: fixture.filePath,
    });
    assert.equal(branches.live, false);
    assert.equal(branches.leafId, fixture.ids[5]);
    assert.ok(branches.nodes.length >= 6);

    const firstAssistant = branches.nodes.find((node) => node.id === fixture.ids[1]);
    assert.ok(firstAssistant);
    assert.equal(firstAssistant.kind, "assistant");
    assert.equal(firstAssistant.childCount, 2);
    assert.equal(firstAssistant.leafId, fixture.ids[5]);

    const firstPrompt = branches.nodes.find((node) => node.id === fixture.ids[0]);
    assert.equal(firstPrompt?.kind, "user");
    assert.equal(firstPrompt?.label, "first prompt");

    const secondPrompt = branches.nodes.find((node) => node.id === fixture.ids[2]);
    const alternative = branches.nodes.find((node) => node.id === fixture.ids[4]);
    assert.equal(secondPrompt?.parentId, fixture.ids[1]);
    assert.equal(alternative?.parentId, fixture.ids[1]);
    // Each sibling carries the leaf of its own subtree, which is what the UI
    // switches to.
    assert.equal(secondPrompt?.leafId, fixture.ids[3]);
    assert.equal(alternative?.leafId, fixture.ids[5]);
  } finally {
    fixture.cleanup();
  }
});

test("getSessionBranches finds a cold session without a filePath", async () => {
  const fixture = createFixture();
  try {
    const branches = await getSessionBranches({ sessionId: fixture.sessionId });
    assert.equal(branches.live, false);
    assert.ok(branches.nodes.some((node) => node.id === fixture.ids[0]));
  } finally {
    fixture.cleanup();
  }
});

test("switching a cold branch stores the leaf for the next start", async () => {
  const fixture = createFixture();
  try {
    const switched = await switchSessionBranch({
      sessionId: fixture.sessionId,
      filePath: fixture.filePath,
      leafId: fixture.ids[3],
    });
    assert.deepEqual(switched, { cancelled: false, live: false, leafId: fixture.ids[3] });
    assert.equal(hasPendingSessionLeaf(fixture.sessionId), true);

    const reopened = SessionManager.open(fixture.filePath);
    applyPendingSessionLeaf(fixture.sessionId, reopened);
    assert.equal(reopened.getLeafId(), fixture.ids[3]);
    assert.equal(hasPendingSessionLeaf(fixture.sessionId), false);
  } finally {
    fixture.cleanup();
  }
});

test("cold sessions report the distill skip instead of faking a summary", async () => {
  const fixture = createFixture();
  try {
    const result = await switchSessionBranch({
      sessionId: fixture.sessionId,
      leafId: fixture.ids[1],
      summarize: true,
    });
    assert.equal(result.live, false);
    assert.equal(result.summarized, undefined);
    assert.equal(result.summarizeSkipped, "not-live");
    assert.equal(result.leafId, fixture.ids[1]);
  } finally {
    fixture.cleanup();
  }
});

test("switching rejects unknown leaves and foreign files", async () => {
  const fixture = createFixture();
  try {
    await assert.rejects(
      () =>
        switchSessionBranch({
          sessionId: fixture.sessionId,
          filePath: fixture.filePath,
          leafId: "does-not-exist",
        }),
      (error: unknown) => error instanceof SessionBranchError && error.code === "E_INVALID_PARAMS",
    );
    await assert.rejects(
      () =>
        getSessionBranches({
          sessionId: fixture.sessionId,
          filePath: join(fixture.dir, "outside.jsonl"),
        }),
      (error: unknown) => error instanceof SessionBranchError && error.code === "ACCESS_DENIED",
    );
  } finally {
    fixture.cleanup();
  }
});

test("live sessions switch branches through navigateTree", { timeout: 30000 }, async () => {
  const fixture = createFixture();
  try {
    const { startRpcSession } = await import("./rpc-manager.ts");
    const { session } = await startRpcSession(fixture.sessionId, fixture.filePath, fixture.cwd);
    try {
      const toAssistant = await switchSessionBranch({
        sessionId: fixture.sessionId,
        leafId: fixture.ids[1],
      });
      assert.equal(toAssistant.cancelled, false);
      assert.equal(toAssistant.live, true);
      assert.equal(toAssistant.leafId, fixture.ids[1]);
      assert.equal(session.inner.sessionManager.getLeafId(), fixture.ids[1]);

      // pi's re-edit semantics: a user message moves the leaf to its parent
      // and hands the text back for the composer.
      const toUser = await switchSessionBranch({
        sessionId: fixture.sessionId,
        leafId: fixture.ids[4],
      });
      assert.equal(toUser.live, true);
      assert.equal(toUser.leafId, fixture.ids[1]);
      assert.match(toUser.editorText ?? "", /alternative prompt/);
    } finally {
      await session.destroy();
    }
  } finally {
    fixture.cleanup();
  }
});
