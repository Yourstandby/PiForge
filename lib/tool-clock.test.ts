import assert from "node:assert/strict";
import { test } from "node:test";

import { markToolEnded, resetToolClocks, settleToolMs, toolClockFor } from "./tool-clock.ts";

test("同一键重复取用返回同一个 clock：重挂载不会重置起点", () => {
  resetToolClocks();
  const first = toolClockFor("call-1");
  first.startedAt = 1000;
  const again = toolClockFor("call-1");
  assert.equal(again, first);
  assert.equal(again.startedAt, 1000);
});

test("settleToolMs 优先用后端 durationMs", () => {
  resetToolClocks();
  const clock = toolClockFor("call-2");
  clock.startedAt = 1000;
  clock.endedAt = 5000;
  assert.equal(settleToolMs(900, clock), 900);
  assert.equal(settleToolMs(undefined, clock), 4000);
});

test("没有起点（历史加载的卡片）不凭空报耗时", () => {
  resetToolClocks();
  const clock = toolClockFor("call-3");
  clock.endedAt = 5000;
  assert.equal(settleToolMs(undefined, clock), undefined);
  assert.equal(settleToolMs(undefined, undefined), undefined);
});

test("markToolEnded 冻结秒表：事件流到了就不再等 toolResult 消息", () => {
  resetToolClocks();
  const clock = toolClockFor("call-4");
  clock.startedAt = 1000;
  const before = Date.now();
  markToolEnded("call-4", 2500);
  assert.ok(clock.endedAt !== undefined && clock.endedAt >= before);
  assert.equal(clock.durationMs, 2500);
  // 消息里的 durationMs 缺失时，退到事件流报告的耗时，而不是继续数下去
  assert.equal(settleToolMs(undefined, clock), 2500);
  // 重复上报不重置结束时刻
  const endedAt = clock.endedAt;
  markToolEnded("call-4");
  assert.equal(clock.endedAt, endedAt);
  assert.equal(clock.durationMs, 2500);
});

test("markToolEnded 忽略空 id", () => {
  resetToolClocks();
  markToolEnded(undefined, 10);
  assert.equal(toolClockFor("undefined").endedAt, undefined);
});

test("注册表超上限时整体清空，不无限增长", () => {
  resetToolClocks();
  const a = toolClockFor("a", 2);
  a.startedAt = 1;
  toolClockFor("b", 2);
  toolClockFor("c", 2);
  assert.notEqual(toolClockFor("a", 2), a);
  assert.equal(toolClockFor("a", 2).startedAt, undefined);
});
