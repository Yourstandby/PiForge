import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateStreamHealth,
  STREAM_FIRST_EVENT_MS,
  STREAM_STALL_MS,
  STREAM_STARTUP_GRACE_MS,
} from "./stream-health.ts";

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
      evaluateStreamHealth({ agentRunning: true, status, lastEventAt: 0, now: 1, attempts: 1 }).kind,
      "reconnecting",
    );
  }
});

test("本轮刚建连的握手阶段（attempts=0）不报重连，避免每次发消息闪提示", () => {
  assert.equal(
    evaluateStreamHealth({
      agentRunning: true,
      status: "connecting",
      lastEventAt: 0,
      now: 1,
      attempts: 0,
    }).kind,
    "ok",
  );
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

test("发送后的起步宽限内不报重连（agentRunning 已 true，SSE 还没建连）", () => {
  const now = 1_000_000;
  for (const status of ["disconnected", "connecting"] as const) {
    assert.deepEqual(
      evaluateStreamHealth({
        agentRunning: true,
        status,
        lastEventAt: 0,
        now,
        attempts: 2,
        runningSince: now - 500,
      }),
      { kind: "ok" },
    );
  }
});

test("宽限内 attempts=0 的 disconnected 也不报重连（还没开始 connect）", () => {
  assert.equal(
    evaluateStreamHealth({
      agentRunning: true,
      status: "disconnected",
      lastEventAt: 0,
      now: 1_000_000,
      attempts: 0,
    }).kind,
    "ok",
  );
});

test("超过起步宽限仍没连上，照旧报 reconnecting", () => {
  const now = 1_000_000;
  const health = evaluateStreamHealth({
    agentRunning: true,
    status: "connecting",
    lastEventAt: 0,
    now,
    attempts: 2,
    runningSince: now - STREAM_STARTUP_GRACE_MS - 1,
  });
  assert.equal(health.kind, "reconnecting");
});

test("本轮一条真实增量都没有 → 用短阈值判卡死（等待首个 token）", () => {
  const now = 1_000_000;
  const runningSince = now - STREAM_FIRST_EVENT_MS - 1;
  // lastEventAt 被 connect() 重置成"现在"——那是重连簿记，不能证明数据到过。
  const health = evaluateStreamHealth({
    agentRunning: true,
    status: "connected",
    lastEventAt: now - 5,
    lastRealEventAt: runningSince - 1_000,
    now,
    runningSince,
  });
  assert.equal(health.kind, "stalled");
});

test("本轮刚开始几秒、还没有增量 → 不误报卡死", () => {
  const now = 1_000_000;
  const runningSince = now - 5_000;
  assert.equal(
    evaluateStreamHealth({
      agentRunning: true,
      status: "connected",
      lastEventAt: now - 5,
      lastRealEventAt: runningSince - 1_000,
      now,
      runningSince,
    }).kind,
    "ok",
  );
});

test("本轮已经流过增量、只是暂时安静 → 仍用 120s 长阈值", () => {
  const now = 1_000_000;
  const runningSince = now - 300_000;
  assert.equal(
    evaluateStreamHealth({
      agentRunning: true,
      status: "connected",
      lastEventAt: now - STREAM_FIRST_EVENT_MS - 5_000,
      lastRealEventAt: now - STREAM_FIRST_EVENT_MS - 5_000,
      now,
      runningSince,
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
