import test from "node:test";
import assert from "node:assert/strict";
import { compactSkipReason, compactSkipReasonFromError } from "./compaction-gate.ts";
import { SessionManager } from "./sdk-adapter.ts";

const SETTINGS = { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 };

const text = (chars: number) => "x".repeat(chars);

function inMemory() {
  return SessionManager.inMemory(process.cwd());
}

function userAndAssistant(manager: SessionManager, chars: number) {
  manager.appendMessage({ role: "user", content: [{ type: "text", text: text(chars) }], timestamp: Date.now() } as never);
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: text(chars) }],
    stopReason: "stop",
    timestamp: Date.now(),
  } as never);
}

test("短会话：没有可丢的历史 → too_short", () => {
  const manager = inMemory();
  userAndAssistant(manager, 200);
  assert.equal(compactSkipReason(manager.getBranch(), SETTINGS), "too_short");
});

test("真正的回归：压缩条目落在分支末端（自动压缩刚跑完）→ already_compacted，而不是抛英文错误", () => {
  const manager = inMemory();
  // 足够多的历史，先确认它本来是可压的
  for (let i = 0; i < 40; i += 1) userAndAssistant(manager, 2_000);
  assert.equal(compactSkipReason(manager.getBranch(), SETTINGS), null);
  // 模拟 pi 自己的压缩：摘要 + 保留最后一轮
  const branch = manager.getBranch();
  const lastUser = branch[branch.length - 2];
  manager.appendCompaction("## Goal\n压缩摘要", lastUser.id, 100_000);
  assert.equal(compactSkipReason(manager.getBranch(), SETTINGS), "already_compacted");
});

test("压缩后又有新历史 → 重新可压", () => {
  const manager = inMemory();
  for (let i = 0; i < 40; i += 1) userAndAssistant(manager, 2_000);
  const branch = manager.getBranch();
  manager.appendCompaction("## Goal\n压缩摘要", branch[branch.length - 2].id, 100_000);
  assert.equal(compactSkipReason(manager.getBranch(), SETTINGS), "already_compacted");
  for (let i = 0; i < 40; i += 1) userAndAssistant(manager, 2_000);
  assert.equal(compactSkipReason(manager.getBranch(), SETTINGS), null);
});

test("pi 的英文错误折回原因码", () => {
  assert.equal(compactSkipReasonFromError("Already compacted"), "already_compacted");
  assert.equal(compactSkipReasonFromError("Nothing to compact (session too small)"), "too_short");
  assert.equal(compactSkipReasonFromError("Conversation too short to compact"), "too_short");
  assert.equal(compactSkipReasonFromError("boom"), null);
});
