import test from "node:test";
import assert from "node:assert/strict";
import { describeContextBudget } from "./context-budget.ts";

test("未知用量：不把 null 当成 0，等级保持 ok 且 hint 说明未知", () => {
  const budget = describeContextBudget({ tokens: null, contextWindow: 200_000 });
  assert.equal(budget.tokens, null);
  assert.equal(budget.ceiling, 200_000);
  assert.equal(budget.ratioToCeiling, 0);
  assert.equal(budget.level, "ok");
  assert.match(budget.hint, /还没统计到/);
});

test("分母是真实窗口：1M 窗口下 16k 只有 1.6%，仍是 ok", () => {
  const budget = describeContextBudget({ tokens: 16_000, contextWindow: 1_000_000 });
  assert.equal(budget.ceiling, 1_000_000);
  assert.equal(budget.ratioToCeiling, 0.016);
  assert.equal(budget.level, "ok");
  assert.match(budget.hint, /16k \/ 1M token（1\.6%）/);
});

test("达到窗口 60% 进入 warn，85% 进入 critical", () => {
  const warn = describeContextBudget({ tokens: 600, contextWindow: 1_000 });
  assert.equal(warn.ratioToCeiling, 0.6);
  assert.equal(warn.level, "warn");
  assert.match(warn.hint, /用过半了/);

  const critical = describeContextBudget({ tokens: 850, contextWindow: 1_000 });
  assert.equal(critical.ratioToCeiling, 0.85);
  assert.equal(critical.level, "critical");
  assert.match(critical.hint, /建议先压缩/);
});

test("阈值跟着窗口走，与压缩硬顶无关", () => {
  // 48k 窗口下 42k = 87.5% → critical；同样的 42k 在 1M 窗口下只是 4.2% → ok。
  const small = describeContextBudget({ tokens: 42_000, contextWindow: 48_000 });
  assert.equal(small.level, "critical");

  const wide = describeContextBudget({ tokens: 42_000, contextWindow: 1_000_000 });
  assert.equal(wide.level, "ok");
  assert.equal(wide.ratioToCeiling, 0.042);
});

test("窗口未知：ceiling=0、ratio=0、等级 ok，hint 说明无法换算", () => {
  const budget = describeContextBudget({ tokens: 12_345, contextWindow: 0 });
  assert.equal(budget.ceiling, 0);
  assert.equal(budget.ratioToCeiling, 0);
  assert.equal(budget.overshoot, false);
  assert.equal(budget.level, "ok");
  assert.match(budget.hint, /没有报告上下文窗口/);
});

test("负数用量按 0 处理", () => {
  const budget = describeContextBudget({ tokens: -1, contextWindow: 100_000 });
  assert.equal(budget.tokens, 0);
  assert.equal(budget.ratioToCeiling, 0);
  assert.equal(budget.level, "ok");
});

test("越过窗口：level=critical 且 overshoot=true", () => {
  const budget = describeContextBudget({ tokens: 120_000, contextWindow: 100_000 });
  assert.equal(budget.level, "critical");
  assert.equal(budget.overshoot, true);
  assert.equal(budget.ratioToCeiling, 1.2);
  assert.match(budget.hint, /已超出窗口/);
});

test("未越顶时 overshoot 恒为 false", () => {
  for (const tokens of [0, 20_000, 60_000, 84_999]) {
    const budget = describeContextBudget({ tokens, contextWindow: 100_000 });
    assert.equal(budget.overshoot, false, `tokens=${tokens}`);
  }
  assert.equal(describeContextBudget({ tokens: null, contextWindow: 0 }).overshoot, false);
});
