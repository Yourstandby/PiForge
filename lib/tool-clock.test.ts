import assert from "node:assert/strict";
import { test } from "node:test";

import { resetToolClocks, settleToolMs, toolClockFor } from "./tool-clock.ts";

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

test("注册表超上限时整体清空，不无限增长", () => {
  resetToolClocks();
  const a = toolClockFor("a", 2);
  a.startedAt = 1;
  toolClockFor("b", 2);
  toolClockFor("c", 2);
  assert.notEqual(toolClockFor("a", 2), a);
  assert.equal(toolClockFor("a", 2).startedAt, undefined);
});
