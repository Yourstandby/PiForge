import test from "node:test";
import assert from "node:assert/strict";
import type {
  SubagentLifecycleEvent,
  SubagentStatus,
  SubagentView,
} from "@contract/domains/subagents";
import {
  applySubagentEvent,
  applySubagentEvents,
  mergeSubagentFrame,
  sortSubagents,
} from "./subagent-view.ts";

function agent(
  id: string,
  status: SubagentStatus,
  startedAt: number,
  extra: Partial<SubagentView> = {},
): SubagentView {
  return {
    id,
    name: `agent-${id}`,
    task: `task for ${id}`,
    parentSessionId: "parent",
    status,
    startedAt,
    endedAt: status === "running" ? null : startedAt + 1_000,
    durationMs: 1_000,
    output: "",
    toolCalls: [],
    ...extra,
  };
}

test("running agents sort first, then newest first", () => {
  const sorted = sortSubagents([
    agent("old-running", "running", 100),
    agent("new-running", "running", 300),
    agent("fresh-finished", "completed", 500),
    agent("old-finished", "failed", 50),
  ]);
  assert.deepEqual(
    sorted.map((item) => item.id),
    ["new-running", "old-running", "fresh-finished", "old-finished"],
  );
});

test("a newly spawned agent lands on top immediately", () => {
  const before = [agent("a1", "completed", 900), agent("a2", "completed", 800)];
  const frame = {
    agents: [...before, agent("a3", "running", 1_000)],
    events: [{ type: "subagent_started" as const, agent: agent("a3", "running", 1_000), timestamp: 1_000 }],
  };
  const after = mergeSubagentFrame(before, frame);
  assert.equal(after[0].id, "a3");
  assert.equal(after[0].status, "running");
  assert.equal(after.length, 3);
});

test("started events insert the card even before the snapshot catches up", () => {
  const started: SubagentLifecycleEvent = {
    type: "subagent_started",
    agent: agent("live", "running", 2_000),
    timestamp: 2_000,
  };
  const list = mergeSubagentFrame([agent("old", "completed", 10)], {
    agents: [agent("old", "completed", 10)],
    events: [started],
  });
  assert.deepEqual(list.map((item) => item.id), ["live", "old"]);
  assert.equal(list[0].task, "task for live", "卡片要带上 target prompt");
});

test("finished events flip the card to its terminal status", () => {
  const running = [agent("x", "running", 10)];
  const finished = { ...agent("x", "completed", 10), endedAt: 1_010, output: "报告正文" };
  const list = applySubagentEvent(running, {
    type: "subagent_finished",
    agent: finished,
    timestamp: 1_010,
  });
  assert.equal(list[0].status, "completed");
  assert.equal(list[0].output, "报告正文");

  const failed = applySubagentEvent(running, {
    type: "subagent_finished",
    agent: { ...agent("x", "failed", 10), error: "boom" },
    timestamp: 1_010,
  });
  assert.equal(failed[0].status, "failed");
  assert.equal(failed[0].error, "boom");

  const cancelled = applySubagentEvent(running, {
    type: "subagent_finished",
    agent: { ...agent("x", "cancelled", 10), error: "Cancelled" },
    timestamp: 1_010,
  });
  assert.equal(cancelled[0].status, "cancelled");
});

test("output events append text and update tool calls in place", () => {
  const running = [
    agent("x", "running", 10, {
      output: "first",
      toolCalls: [{ id: "t1", name: "read", status: "running", startedAt: 20, endedAt: null }],
    }),
  ];
  const withText = applySubagentEvent(running, {
    type: "subagent_output",
    id: "x",
    name: "agent-x",
    text: "second",
    timestamp: 30,
  });
  assert.equal(withText[0].output, "first\n\nsecond");

  const withTool = applySubagentEvent(withText, {
    type: "subagent_output",
    id: "x",
    name: "agent-x",
    text: "",
    toolCall: { id: "t1", name: "read", status: "ok", startedAt: 20, endedAt: 40 },
    timestamp: 40,
  });
  assert.equal(withTool[0].toolCalls[0].status, "ok");
  assert.equal(withTool[0].toolCalls[0].endedAt, 40);
});

test("a snapshot that already contains the event text does not duplicate it", () => {
  const list = applySubagentEvent([agent("x", "running", 10, { output: "line one" })], {
    type: "subagent_output",
    id: "x",
    name: "agent-x",
    text: "line one",
    timestamp: 20,
  });
  assert.equal(list[0].output, "line one");
});

test("replayed started events never downgrade a finished card", () => {
  const finished = [agent("x", "completed", 10, { output: "done" })];
  const list = applySubagentEvent(finished, {
    type: "subagent_started",
    agent: agent("x", "running", 10),
    timestamp: 20,
  });
  assert.equal(list[0].status, "completed");
  assert.equal(list[0].output, "done");
});

test("the snapshot is authoritative: pruned agents disappear", () => {
  const previous = [agent("gone", "completed", 10), agent("kept", "running", 20)];
  const list = mergeSubagentFrame(previous, { agents: [agent("kept", "running", 20)] });
  assert.deepEqual(list.map((item) => item.id), ["kept"]);
});

test("a frame without a snapshot keeps the previous list", () => {
  const previous = [agent("x", "running", 10)];
  const list = mergeSubagentFrame(previous, {
    events: [{ type: "subagent_output", id: "x", name: "agent-x", text: "more", timestamp: 20 }],
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].output, "more");
});

test("batched events apply in order", () => {
  const events: SubagentLifecycleEvent[] = [
    { type: "subagent_started", agent: agent("x", "running", 10), timestamp: 10 },
    { type: "subagent_output", id: "x", name: "agent-x", text: "step 1", timestamp: 20 },
    {
      type: "subagent_finished",
      agent: { ...agent("x", "completed", 10), output: "final" },
      timestamp: 30,
    },
  ];
  const list = applySubagentEvents([], events);
  assert.equal(list.length, 1);
  assert.equal(list[0].status, "completed");
  // finished 事件带的是权威快照，文本以它为准（增量的 step 1 被覆盖）。
  assert.equal(list[0].output, "final");
});
