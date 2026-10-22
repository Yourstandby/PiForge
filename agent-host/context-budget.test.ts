import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MAX_CONTEXT_TOKENS,
  describeContextBudget,
} from "./context-budget.ts";

test("未知用量：不把 null 当成 0，等级保持 ok 且 hint 说明未知", () => {
  const budget = describeContextBudget({ tokens: null, contextWindow: 200_000 });
  assert.equal(budget.tokens, null);
  assert.equal(budget.ceiling, DEFAULT_MAX_CONTEXT_TOKENS);
  assert.equal(budget.ratioToCeiling, 0);
  assert.equal(budget.ratioToWindow, 0);
  assert.equal(budget.level, "ok");
  assert.match(budget.hint, /还没统计到/);
  assert.match(budget.hint, /自动压缩/);
});

test("低于 60% 硬顶是 ok", () => {
  const budget = describeContextBudget({ tokens: 20_000, contextWindow: 200_000 });
  assert.equal(budget.tokens, 20_000);
  assert.equal(budget.ceiling, 48_000);
  assert.equal(budget.ratioToCeiling, 20_000 / 48_000);
  assert.equal(budget.ratioToWindow, 0.1);
  assert.equal(budget.level, "ok");
  assert.match(budget.hint, /宽裕/);
});

test("达到 60% 硬顶进入 warn", () => {
  const budget = describeContextBudget({ tokens: 28_800, contextWindow: 200_000 });
  assert.equal(budget.ratioToCeiling, 0.6);
  assert.equal(budget.level, "warn");
  assert.match(budget.hint, /再聊几轮就会自动压缩/);
});

test("达到 85% 硬顶进入 critical", () => {
  const budget = describeContextBudget({ tokens: 40_800, contextWindow: 200_000 });
  assert.equal(budget.ratioToCeiling, 0.85);
  assert.equal(budget.level, "critical");
  assert.match(budget.hint, /下一轮就会自动压缩/);
});

test("自定义硬顶同时改变等级与 ratioToCeiling", () => {
  const warn = describeContextBudget({
    tokens: 65_000,
    contextWindow: 200_000,
    maxContextTokens: 100_000,
  });
  assert.equal(warn.ceiling, 100_000);
  assert.equal(warn.ratioToCeiling, 0.65);
  assert.equal(warn.ratioToWindow, 0.325);
  assert.equal(warn.level, "warn");

  const critical = describeContextBudget({
    tokens: 90_000,
    contextWindow: 200_000,
    maxContextTokens: 100_000,
  });
  assert.equal(critical.level, "critical");
});

test("无效硬顶回落到默认值，负数用量按 0 处理", () => {
  const budget = describeContextBudget({
    tokens: -1,
    contextWindow: 0,
    maxContextTokens: 0,
  });
  assert.equal(budget.tokens, 0);
  assert.equal(budget.ceiling, DEFAULT_MAX_CONTEXT_TOKENS);
  assert.equal(budget.ratioToWindow, 0);
  assert.equal(budget.level, "ok");
});

test("越过硬顶：level=critical 且 overshoot=true，hint 说会立刻压", () => {
  const budget = describeContextBudget({ tokens: 102_400, contextWindow: 200_000 });
  assert.equal(budget.level, "critical");
  assert.equal(budget.overshoot, true);
  assert.ok(budget.ratioToCeiling > 2);
  assert.match(budget.hint, /已经把旧内容压缩|装不下了/);
});

test("未越顶时 overshoot 恒为 false", () => {
  for (const tokens of [0, 20_000, 40_800, 47_999]) {
    const budget = describeContextBudget({ tokens, contextWindow: 200_000 });
    assert.equal(budget.overshoot, false, `tokens=${tokens}`);
  }
  assert.equal(describeContextBudget({ tokens: null, contextWindow: 0 }).overshoot, false);
});
