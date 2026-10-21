import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTEXT_BREAKER_TOKENS,
  MAX_DISCUSSION_TURNS,
  MAX_PARENT_REPORT_CHARS,
  REPORT_TRUNCATED_NOTICE,
  checkContextBreaker,
  checkTurnBudget,
  condenseReport,
  guardFailureText,
} from "./agent-guards.ts";

test("the money valves use the documented thresholds", () => {
  assert.equal(MAX_DISCUSSION_TURNS, 3);
  assert.equal(CONTEXT_BREAKER_TOKENS, 10_000);
  assert.ok(MAX_PARENT_REPORT_CHARS <= 2_000, "回给主 Agent 的摘要必须短");
});

test("turn budget allows at most three request-response rounds", () => {
  assert.equal(checkTurnBudget(0).allowed, true);
  assert.equal(checkTurnBudget(2).allowed, true);
  const third = checkTurnBudget(3);
  assert.equal(third.allowed, false);
  assert.equal(third.maxTurns, 3);
  assert.match(third.reason ?? "", /3 轮对话上限/);
  assert.match(third.reason ?? "", /新建一个子 Agent/);
});

test("context breaker trips above 10k tokens and stays quiet when usage is unknown", () => {
  assert.equal(checkContextBreaker(9_999).breached, false);
  assert.equal(checkContextBreaker(10_000).breached, false);
  const breach = checkContextBreaker(10_001);
  assert.equal(breach.breached, true);
  assert.equal(breach.limit, CONTEXT_BREAKER_TOKENS);
  assert.match(breach.reason ?? "", /熔断阈值/);

  // 拿不到用量时不能误伤正常任务。
  assert.equal(checkContextBreaker(null).breached, false);
  assert.equal(checkContextBreaker(undefined).breached, false);
  assert.equal(checkContextBreaker(Number.NaN).breached, false);
  assert.equal(checkContextBreaker(-5).breached, false);
});

test("short reports pass through untouched", () => {
  const text = "登录页已经改成 OAuth，改动在 src/login.tsx:42。";
  const result = condenseReport(text);
  assert.equal(result.condensed, false);
  assert.equal(result.text, text);
});

test("long reports are condensed to the conclusion plus key bullets", () => {
  const long = [
    "结论：会话恢复逻辑有两处竞态，建议先修 A 再修 B。",
    "",
    "- src/session-loader.ts:88 读取顺序错了",
    "- src/session-events.ts:42 少了一个 guard",
    "- tests/session.test.ts:12 需要补一个用例",
    ...Array.from({ length: 300 }, (_, index) => `日志行 ${index + 1}：${"x".repeat(20)}`),
  ].join("\n");
  const result = condenseReport(long);
  assert.equal(result.condensed, true);
  assert.ok(result.text.length <= MAX_PARENT_REPORT_CHARS);
  assert.match(result.text, /结论：会话恢复逻辑/);
  assert.match(result.text, /src\/session-loader\.ts:88/);
  assert.ok(result.text.includes(REPORT_TRUNCATED_NOTICE));
  assert.doesNotMatch(result.text, /日志行 300/);
});

test("a single huge paragraph is clipped, not dropped", () => {
  const huge = "甲".repeat(5_000);
  const result = condenseReport(huge, 400);
  assert.equal(result.condensed, true);
  assert.ok(result.text.length <= 400);
  assert.ok(result.text.length > 100);
});

test("empty output is reported explicitly", () => {
  assert.equal(condenseReport("   \n\n ").text, "(子 Agent 没有产出文本)");
});

test("guard failure text is explicit about being an intentional stop", () => {
  const text = guardFailureText("context", "上下文已达 12,345 tokens");
  assert.match(text, /上下文熔断/);
  assert.match(text, /省钱阀门主动中断/);
});
