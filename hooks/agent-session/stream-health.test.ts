import test from "node:test";
import assert from "node:assert/strict";
import { evaluateStreamHealth, STREAM_STALL_MS } from "./stream-health.ts";

test("未运行时永远 ok：断流不影响下一轮发送", () => {
  assert.deepEqual(
    evaluateStreamHealth({
      agentRunning: false,
      status: "failed",
      lastEventAt: 0,
      now: 1_000_000,
    }),
    { kind: "ok" },
  );
});

test("重试耗尽后报 failed 并带上次数", () => {
  assert.deepEqual(
    evaluateStreamHealth({
      agentRunning: true,
      status: "failed",
      lastEventAt: 0,
      now: 1_000_000,
      attempts: 6,
    }),
    { kind: "failed", attempts: 6 },
  );
});

test("退避重连中报 reconnecting", () => {
  for (const status of ["connecting", "disconnected"] as const) {
    assert.equal(
      evaluateStreamHealth({ agentRunning: true, status, lastEventAt: 0, now: 1 }).kind,
      "reconnecting",
    );
  }
});

test("连接在但超过阈值没增量 → stalled", () => {
  const now = 1_000_000;
  const health = evaluateStreamHealth({
    agentRunning: true,
    status: "connected",
    lastEventAt: now - STREAM_STALL_MS,
    now,
  });
  assert.equal(health.kind, "stalled");
});

test("阈值内正常增量 → ok", () => {
  const now = 1_000_000;
  assert.equal(
    evaluateStreamHealth({
      agentRunning: true,
      status: "connected",
      lastEventAt: now - (STREAM_STALL_MS - 1),
      now,
    }).kind,
    "ok",
  );
});

test("刚连上还没来事件（lastEventAt=0）不误报", () => {
  assert.equal(
    evaluateStreamHealth({
      agentRunning: true,
      status: "connected",
      lastEventAt: 0,
      now: 1_000_000,
    }).kind,
    "ok",
  );
});
