import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_HOST_HARD_TIMEOUT_MS,
  AGENT_HOST_READY_TIMEOUT_MS,
  describeHostState,
  markHostBooting,
  markHostReady,
  markHostStopped,
  onHardTimeout,
  onSoftTimeout,
} from "./host-readiness.ts";

test("软超时提升到 20s，硬超时 60s（0.9.0 的 10s 会误杀慢启动的 Host）", () => {
  assert.equal(AGENT_HOST_READY_TIMEOUT_MS, 20_000);
  assert.equal(AGENT_HOST_HARD_TIMEOUT_MS, 60_000);
  assert.ok(AGENT_HOST_HARD_TIMEOUT_MS > AGENT_HOST_READY_TIMEOUT_MS);
});

test("软超时只报告不杀进程（0.9.0 的 bug 就是这里 kill）", () => {
  const booting = markHostBooting();
  const first = onSoftTimeout(booting);
  assert.equal(first.action, "report");
  assert.equal(first.snapshot.state, "degraded");
  assert.equal(first.snapshot.reportedSoftTimeout, true);
  // 重复触发：仍然只是报告，不升级成 kill。
  const second = onSoftTimeout(first.snapshot);
  assert.equal(second.action, "report");
});

test("软超时之后才到的 host_ready 依然能翻成 ready（慢机器 20–60s 就绪）", () => {
  // 先走到 degraded，再由 host_ready 覆盖（状态机允许"迟到就绪"）。
  const degraded = onSoftTimeout(markHostBooting()).snapshot;
  assert.equal(degraded.state, "degraded");
  const ready = markHostReady();
  assert.equal(ready.state, "ready");
  assert.equal(ready.ready, true);
  assert.equal(onSoftTimeout(ready).action, "ignore");
  assert.equal(onHardTimeout(ready).action, "ignore");
});

test("硬超时才会杀，且只对仍在启动的 Host 生效", () => {
  const degraded = onSoftTimeout(markHostBooting()).snapshot;
  assert.equal(degraded.state, "degraded");
  assert.equal(onHardTimeout(degraded).action, "kill");
  assert.equal(onHardTimeout(markHostStopped()).action, "ignore");
});

test("重启会重置软超时报告位置，不会漏报新一轮", () => {
  assert.equal(onSoftTimeout(markHostBooting()).snapshot.reportedSoftTimeout, true);
  const reboot = markHostBooting();
  assert.equal(reboot.reportedSoftTimeout, false);
  assert.equal(onSoftTimeout(reboot).snapshot.reportedSoftTimeout, true);
});

test("degraded 不等于错误：UI 不弹阻断式提示", () => {
  assert.equal(describeHostState("degraded").blocking, false);
  assert.equal(describeHostState("booting").blocking, false);
  assert.equal(describeHostState("ready").blocking, false);
  assert.equal(describeHostState("off").blocking, true);
});
