import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTEXT_BREAKER_TOKENS,
  DEFAULT_SUBAGENT_MAX_TURNS,
  MAX_DISCUSSION_TURNS,
  MAX_PARENT_REPORT_CHARS,
  REPORT_TRUNCATED_NOTICE,
  SUBAGENT_MAX_TURNS_ENV,
  buildSubagentFailureReport,
  checkContextBreaker,
  checkTurnBudget,
  condenseReport,
  guardFailureText,
  resolveSubagentMaxTurns,
} from "./agent-guards.ts";

test("the money valves use the documented thresholds", () => {
  assert.equal(DEFAULT_SUBAGENT_MAX_TURNS, 6);
  // 轮数上限必须高于空转阈值（5），否则 progress-guard 永远轮不到生效。
  assert.ok(DEFAULT_SUBAGENT_MAX_TURNS > 5, "轮数上限必须高于 progress-guard 阈值");
  assert.equal(MAX_DISCUSSION_TURNS, DEFAULT_SUBAGENT_MAX_TURNS, "旧名必须跟着新默认值走");
  assert.equal(CONTEXT_BREAKER_TOKENS, 10_000);
  assert.ok(MAX_PARENT_REPORT_CHARS <= 2_000, "回给主 Agent 的摘要必须短");
});

test("turn budget allows exactly maxTurns rounds (off-by-one guard)", () => {
  // 参数是「即将使用的那一轮的序号」（1 起），所以 1..6 全放行，第 7 轮才拦。
  for (const turn of [1, 2, 3, 4, 5, 6]) {
    assert.equal(checkTurnBudget(turn).allowed, true, `第 ${turn} 轮必须放行`);
  }
  const seventh = checkTurnBudget(7);
  assert.equal(seventh.allowed, false);
  assert.equal(seventh.maxTurns, 6);
  assert.match(seventh.reason ?? "", /6 轮对话上限/);
  assert.match(seventh.reason ?? "", /新建一个子 Agent/);
});

test("turn budget honours an explicit cap and treats null as unlimited (fleet)", () => {
  assert.equal(checkTurnBudget(3, 3).allowed, true, "第 3、3 轮必须放行");
  assert.equal(checkTurnBudget(4, 3).allowed, false);
  // 常驻舰队：无硬上限，只受 progress-guard 约束。
  assert.equal(checkTurnBudget(99, null).allowed, true);
  assert.equal(checkTurnBudget(99, null).maxTurns, null);
});

test("turn cap is configurable via PIFORGE_SUBAGENT_MAX_TURNS", () => {
  assert.equal(resolveSubagentMaxTurns({}).maxTurns, DEFAULT_SUBAGENT_MAX_TURNS);
  assert.equal(resolveSubagentMaxTurns({}).source, "default");
  const env = resolveSubagentMaxTurns({ [SUBAGENT_MAX_TURNS_ENV]: "9" });
  assert.equal(env.maxTurns, 9);
  assert.equal(env.source, "env");
  assert.equal(checkTurnBudget(9, env.maxTurns).allowed, true);
  assert.equal(checkTurnBudget(10, env.maxTurns).allowed, false);
  for (const bad of ["0", "-2", "abc", "2.5", ""] ) {
    const decision = resolveSubagentMaxTurns({ [SUBAGENT_MAX_TURNS_ENV]: bad });
    assert.equal(decision.maxTurns, DEFAULT_SUBAGENT_MAX_TURNS, `非法值 ${JSON.stringify(bad)} 必须回落默认`);
  }
});

test("ok:false report names the trip, the turn count and the last effective action", () => {
  const turns = buildSubagentFailureReport({
    id: "subagent-abc123",
    name: "m-guards",
    status: "cancelled",
    trip: "turns",
    turns: 6,
    maxTurns: 6,
    lastAction: "read agent-host/agent-guards.ts（ok）",
    reason: "已用满 6 轮对话上限（单次请求-响应制）。",
  });
  const progress = buildSubagentFailureReport({
    id: "subagent-abc123",
    name: "m-guards",
    status: "cancelled",
    trip: "progress",
    turns: 5,
    maxTurns: 6,
    lastAction: "grep progress-guard（ok）",
    reason: "连续 5 轮没有任何文件读取 / 命令执行 / 代码修改（阈值 5 轮）。",
  });
  const context = buildSubagentFailureReport({
    id: "subagent-abc123",
    name: "m-guards",
    status: "cancelled",
    trip: "context",
    turns: 2,
    maxTurns: 6,
    lastAction: null,
    reason: "上下文 12 000 tokens 超过 10 000。",
  });

  // 三种路径文案必须各不相同（主 Agent 靠它决策，不能压成一句 "was cancelled"）。
  assert.notEqual(turns, progress);
  assert.notEqual(turns, context);
  assert.notEqual(progress, context);

  // 轮数上限路径：need_help + 已用轮数 + 最后动作 + 三条建议（重派 / 拆小任务 / 换常驻）。
  assert.match(turns, /status: need_help/);
  assert.match(turns, /turns: 6\/6/);
  assert.match(turns, /last_action: read agent-host\/agent-guards\.ts（ok）/);
  assert.match(turns, /subagent-abc123/);
  assert.match(turns, /拆成 2–3 个更小的子任务/);
  assert.match(turns, /herdr_spawn/);

  // 空转路径：也是 need_help，但建议与轮数路径不同。
  assert.match(progress, /status: need_help/);
  assert.match(progress, /turns: 5\/6/);
  assert.match(progress, /last_action: grep progress-guard（ok）/);
  assert.match(progress, /不要原样重试/);
  assert.doesNotMatch(progress, /拆成 2–3 个更小的子任务/);

  // 上下文熔断：失败（不是 need_help），且从没调过工具时要写清楚。
  assert.match(context, /status: failed/);
  assert.match(context, /last_action: 无（从未调用过任何工具）/);

  // 舰队 Agent（无硬上限）也要能正确渲染。
  const fleet = buildSubagentFailureReport({
    id: "herdr-1",
    name: "scout",
    status: "cancelled",
    trip: "progress",
    turns: 7,
    maxTurns: null,
    lastAction: "ls .（ok）",
    reason: "空转",
  });
  assert.match(fleet, /turns: 7\/无硬上限/);
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
