import test from "node:test";
import assert from "node:assert/strict";
import { billableTokens, inputUnitPrice } from "./usage-billing.ts";

const usage = (over: Record<string, unknown> = {}) =>
  ({
    input: 1000,
    output: 200,
    cacheRead: 8000,
    cacheWrite: 0,
    cost: { input: 0.0005, output: 0.0004, cacheRead: 0.00004, cacheWrite: 0, total: 0.00094 },
    ...over,
  }) as never;

test("计费 tokens = 费用 ÷ 未缓存输入单价", () => {
  const u = usage();
  assert.equal(inputUnitPrice(u), 0.0005 / 1000);
  assert.equal(billableTokens(u), 0.00094 / (0.0005 / 1000));
});

test("与费用严格成正比（缓存/输出已折进同一量纲）", () => {
  const a = billableTokens(usage())!;
  // 同一单价、费用翻倍 → 计费 tokens 也翻倍（这正是原来两行相除不成立的那条性质）。
  const b = billableTokens(
    usage({
      output: 400,
      cost: { input: 0.0005, output: 0.0008, cacheRead: 0.00008, cacheWrite: 0, total: 0.00188 },
    }),
  )!;
  assert.ok(Math.abs(b / a - 2) < 1e-9, `${a} vs ${b}`);
});

test("input=0（全缓存命中）退回同轮单价", () => {
  const u = usage({ input: 0, cost: { input: 0, output: 0.0004, cacheRead: 0.00004, cacheWrite: 0, total: 0.00044 } });
  assert.equal(inputUnitPrice(u), null);
  assert.equal(billableTokens(u), null);
  assert.equal(billableTokens(u, 0.0005 / 1000), 0.00044 / (0.0005 / 1000));
});

test("免费模型 / 缺字段返回 null，由调用方回退旧口径", () => {
  assert.equal(billableTokens(null), null);
  assert.equal(billableTokens(usage({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } })), null);
});
