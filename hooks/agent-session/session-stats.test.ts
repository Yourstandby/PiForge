import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "../../lib/types.ts";
import { calculateSessionActivity, calculateSessionStats } from "./session-stats.ts";

test("returns null when there are no usage values", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: "hello" },
    {
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      model: "claude",
      provider: "anthropic",
    },
  ];

  assert.equal(calculateSessionStats(messages), null);
});

test("sums assistant usage and cost and calculates cacheHitRate", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: "hello" },
    {
      role: "assistant",
      content: [{ type: "text", text: "first" }],
      model: "claude",
      provider: "anthropic",
      usage: {
        input: 10,
        output: 20,
        cacheRead: 30,
        cacheWrite: 40,
        cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
      },
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "second" }],
      model: "claude",
      provider: "anthropic",
      usage: {
        input: 1,
        output: 2,
        cacheRead: 3,
        cacheWrite: 4,
        cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
      },
    },
  ];

  assert.deepEqual(calculateSessionStats(messages), {
    tokens: { input: 11, output: 22, cacheRead: 33, cacheWrite: 44, total: 110 },
    cacheHitRate: 37.5,
    cost: 11,
  });
});

test("sums reasoning tokens separately without adding them to total", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: "hello" },
    {
      role: "assistant",
      content: [{ type: "text", text: "thinking..." }],
      model: "claude",
      provider: "anthropic",
      usage: {
        input: 10,
        output: 20,
        reasoning: 8,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
      },
    },
  ];

  assert.deepEqual(calculateSessionStats(messages), {
    tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 8, total: 30 },
    cacheHitRate: 0,
    cost: 3,
  });
});

test("calculateSessionActivity counts turns and tool calls with error flags", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: "first" },
    {
      role: "assistant",
      content: [
        { type: "toolCall", toolCallId: "t1", toolName: "read", input: {} },
        { type: "toolCall", toolCallId: "t2", toolName: "bash", input: {} },
        { type: "text", text: "done" },
      ],
      model: "claude",
      provider: "anthropic",
    },
    {
      role: "toolResult",
      toolCallId: "t1",
      toolName: "read",
      content: [{ type: "text", text: "ok" }],
    },
    {
      role: "toolResult",
      toolCallId: "t2",
      toolName: "bash",
      content: [{ type: "text", text: "boom" }],
      isError: true,
    },
    { role: "user", content: "second" },
    {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "t3", toolName: "read", input: {} }],
      model: "claude",
      provider: "anthropic",
    },
  ];

  const activity = calculateSessionActivity(messages);
  assert.equal(activity.turns, 2);
  assert.equal(activity.toolCalls.total, 3);
  assert.deepEqual(activity.toolCalls.byTool, [
    { name: "read", count: 2, errors: 0 },
    { name: "bash", count: 1, errors: 1 },
  ]);
});

test("calculateSessionActivity is zeroed out for an empty transcript", () => {
  assert.deepEqual(calculateSessionActivity([]), {
    turns: 0,
    toolCalls: { total: 0, byTool: [] },
  });
});
