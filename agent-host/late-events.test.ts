import assert from "node:assert/strict";
import test from "node:test";
import { isLateStreamEvent, startsNewRun } from "./late-events.ts";

test("增量内容事件算迟到事件", () => {
  for (const type of ["message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end"]) {
    assert.equal(isLateStreamEvent(type), true, type);
  }
});

test("生命周期事件不算迟到：状态机还要靠它们收尾", () => {
  for (const type of ["agent_start", "agent_end", "agent_settled", "agent_error", "turn_end", "custom"]) {
    assert.equal(isLateStreamEvent(type), false, type);
  }
});

test("新一轮开始的事件会关闭丢弃窗口", () => {
  assert.equal(startsNewRun("agent_start"), true);
  assert.equal(startsNewRun("turn_start"), true);
  assert.equal(startsNewRun("message_update"), false);
});
