import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_ROUNDS_WITHOUT_PROGRESS,
  advanceProgress,
  checkProgressBudget,
  initialProgressState,
  isProgressTool,
} from "./progress-guard.ts";

test("探索与副作用工具都算进展；纯元动作不算", () => {
  for (const tool of ["read", "grep", "find", "ls", "bash", "shell", "edit", "write"]) {
    assert.equal(isProgressTool(tool), true, `${tool} 应算进展`);
  }
  for (const tool of ["tool_search", "memory", "spawn_agent", "herdr_spawn"]) {
    assert.equal(isProgressTool(tool), false, `${tool} 不该算进展`);
  }
  assert.equal(isProgressTool(undefined), false);
  assert.equal(isProgressTool(null), false);
  assert.equal(isProgressTool("unknown_tool"), false);
});

test("只读调研连续 3 轮不算空转（探索性任务不该被误杀）", () => {
  let state = initialProgressState();
  for (let round = 0; round < 3; round += 1) {
    state = advanceProgress(state, true); // 每轮都读了文件
    const budget = checkProgressBudget(state);
    assert.equal(budget.stop, false);
    assert.equal(budget.roundsWithoutProgress, 0);
  }
  assert.equal(state.progressEvents, 3);
});

test("连续 4 轮没有任何动作仍不判停（阈值是 5）", () => {
  let state = initialProgressState();
  for (let round = 0; round < 4; round += 1) state = advanceProgress(state, false);
  assert.equal(checkProgressBudget(state).stop, false);
  assert.equal(MAX_ROUNDS_WITHOUT_PROGRESS, 5);
});

test("连续 5 轮没有任何动作 → 判空转，理由里写清阈值与建议", () => {
  let state = initialProgressState();
  for (let round = 0; round < 5; round += 1) state = advanceProgress(state, false);
  const budget = checkProgressBudget(state);
  assert.equal(budget.stop, true);
  assert.equal(budget.roundsWithoutProgress, 5);
  assert.equal(budget.threshold, 5);
  assert.match(String(budget.reason), /连续 5 轮/);
  assert.match(String(budget.reason), /文件读取/);
});

test("中途出现过一次动作就清零（不是累计 5 次空转）", () => {
  let state = initialProgressState();
  for (let round = 0; round < 4; round += 1) state = advanceProgress(state, false);
  state = advanceProgress(state, true); // 第 5 轮读了个文件
  assert.equal(state.roundsWithoutProgress, 0);
  for (let round = 0; round < 4; round += 1) state = advanceProgress(state, false);
  assert.equal(checkProgressBudget(state).stop, false);
  // 再来一轮才到 5
  state = advanceProgress(state, false);
  assert.equal(checkProgressBudget(state).stop, true);
});

test("阈值可覆盖（实验/调参用），且最小为 1", () => {
  const state = advanceProgress(initialProgressState(), false);
  assert.equal(checkProgressBudget(state, 1).stop, true);
  assert.equal(checkProgressBudget(state, 0).threshold, 1);
  assert.equal(checkProgressBudget(state, 3).stop, false);
});

test("非法计数（负数 / 小数）被规整，不会因为脏数据误判", () => {
  const budget = checkProgressBudget({ roundsWithoutProgress: -3, progressEvents: 0 });
  assert.equal(budget.stop, false);
  assert.equal(budget.roundsWithoutProgress, 0);
  assert.equal(checkProgressBudget({ roundsWithoutProgress: 5.9, progressEvents: 0 }).roundsWithoutProgress, 5);
});
