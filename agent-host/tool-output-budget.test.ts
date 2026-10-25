import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveToolOutputChars,
  withCharsLimit,
  DEFAULT_TOOL_OUTPUT_BUDGET,
  READ_TOOL_OUTPUT_BUDGET,
  TRUNCATION_HINT,
  countTextLines,
  exceedsToolOutputBudget,
  toolOutputBudget,
  truncationNotice,
  truncateToolOutput,
} from "./tool-output-budget.ts";
import { shouldPersistToolOutput } from "./tool-outputs.ts";

function lines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");
}

test("budgets are the documented hard caps", () => {
  assert.equal(DEFAULT_TOOL_OUTPUT_BUDGET.maxChars, 4_000);
  assert.equal(DEFAULT_TOOL_OUTPUT_BUDGET.headChars, 1_500);
  assert.equal(DEFAULT_TOOL_OUTPUT_BUDGET.tailChars, 1_500);
  assert.equal(READ_TOOL_OUTPUT_BUDGET.maxChars, 4_000);
  assert.equal(READ_TOOL_OUTPUT_BUDGET.headChars, 3_000);
  assert.equal(toolOutputBudget("read"), READ_TOOL_OUTPUT_BUDGET);
  assert.equal(toolOutputBudget("bash"), DEFAULT_TOOL_OUTPUT_BUDGET);
  assert.equal(toolOutputBudget(undefined), DEFAULT_TOOL_OUTPUT_BUDGET);
});

test("countTextLines matches the trailing-newline convention", () => {
  assert.equal(countTextLines(""), 0);
  assert.equal(countTextLines("a"), 1);
  assert.equal(countTextLines("a\nb"), 2);
  assert.equal(countTextLines("a\nb\n"), 2);
});

test("text under the budget is returned untouched", () => {
  const text = lines(20);
  const result = truncateToolOutput(text);
  assert.equal(result.truncated, false);
  assert.equal(result.text, text);
  assert.equal(result.totalLines, 20);
});

test("over-long output keeps head and tail and states the real total", () => {
  const text = lines(1_000);
  const result = truncateToolOutput(text);
  assert.equal(result.truncated, true);
  assert.equal(result.truncatedBy, "chars");
  assert.equal(result.totalLines, 1_000);
  assert.match(result.text, /^line 1\n/);
  assert.match(result.text, /\[\.\.\.已截断 1000 行/);
  assert.ok(result.text.includes(TRUNCATION_HINT), "必须带上批量续读的引导");
  assert.match(result.text, /line 1000$/);
  assert.doesNotMatch(result.text, /line 500/);
  assert.ok(
    Buffer.byteLength(result.text, "utf8") < Buffer.byteLength(text, "utf8") / 2,
    "截断后应显著小于原文",
  );
});

test("char cap wins even when the line count is small", () => {
  const oneLongLine = "x".repeat(40 * 1024);
  const result = truncateToolOutput(oneLongLine);
  assert.equal(result.truncated, true);
  assert.equal(result.truncatedBy, "chars");
  assert.ok(
    result.text.length <= DEFAULT_TOOL_OUTPUT_BUDGET.headChars + DEFAULT_TOOL_OUTPUT_BUDGET.tailChars + 400,
    "头尾窗口 + 说明块之外不应再留正文",
  );
  assert.match(result.text, /已截断/);
});

test("read budget keeps a long head plus a short tail", () => {
  const text = lines(1_000);
  const result = truncateToolOutput(text, READ_TOOL_OUTPUT_BUDGET);
  assert.match(result.text, /^line 1\n/);
  assert.match(result.text, /已截断 1000 行/);
  assert.match(result.text, /line 1000$/);
});

test("pi's pagination hint survives truncation", () => {
  const text = `${lines(800)}\n\n[Showing lines 1-800 of 5000. Use offset=801 to continue.]`;
  const result = truncateToolOutput(text, READ_TOOL_OUTPUT_BUDGET);
  assert.equal(result.totalLines, 802);
  assert.match(result.text, /Use offset=801 to continue/);
  // 提示必须还在正文之后，不能被截掉。
  assert.ok(result.text.indexOf("Use offset=801") > result.text.indexOf("已截断"));
});

test("truncation is idempotent", () => {
  const once = truncateToolOutput(lines(1_000), DEFAULT_TOOL_OUTPUT_BUDGET);
  const twice = truncateToolOutput(once.text, {
    ...DEFAULT_TOOL_OUTPUT_BUDGET,
    maxLines: 20,
    headLines: 10,
    tailLines: 5,
  });
  assert.equal(
    (twice.text.match(/已截断/g) ?? []).length,
    1,
    "二次裁剪不应叠加说明块",
  );
});

test("exceedsToolOutputBudget mirrors the two limits", () => {
  assert.equal(exceedsToolOutputBudget(lines(59)), false);
  assert.equal(exceedsToolOutputBudget(lines(61)), true);
  assert.equal(exceedsToolOutputBudget("y".repeat(4_001)), true);
});

test("truncation notice wording is stable", () => {
  assert.equal(
    truncationNotice(1_234, DEFAULT_TOOL_OUTPUT_BUDGET),
    "[...已截断 1234 行...]（已保留前 1500 字符 + 后 1500 字符）",
  );
  assert.equal(
    truncationNotice(1_234, READ_TOOL_OUTPUT_BUDGET, 900),
    "[...已截断 1234 行 / 900 字符...]（已保留前 3000 字符 + 后 1000 字符）",
  );
  // 引导必须指向「一次脚本批量读 / 工具翻页」，而不是让模型逐条 read。
  assert.match(TRUNCATION_HINT, /codemode/);
  assert.match(TRUNCATION_HINT, /tool_history_get/);
  assert.match(TRUNCATION_HINT, /不要逐条续读/);
});

// ---------------------------------------------------------------------------
// L-D 实验开关（PIFORGE_TOOL_OUTPUT_CHARS）
// ---------------------------------------------------------------------------

test("resolveToolOutputChars: 未设置 → 默认 4000，source=default", () => {
  const setting = resolveToolOutputChars({});
  assert.equal(setting.maxChars, 4_000);
  assert.equal(setting.source, "default");
});

test("resolveToolOutputChars: 2000 生效；非法值（字符/null/NaN/越界）保留默认", () => {
  assert.equal(resolveToolOutputChars({ PIFORGE_TOOL_OUTPUT_CHARS: "2000" }).maxChars, 2_000);
  assert.equal(resolveToolOutputChars({ PIFORGE_TOOL_OUTPUT_CHARS: "2000" }).source, "env");
  for (const raw of ["abc", "0", "-100", "10", "999999", "NaN"]) {
    const setting = resolveToolOutputChars({ PIFORGE_TOOL_OUTPUT_CHARS: raw });
    assert.equal(setting.maxChars, 4_000, raw);
    assert.equal(setting.source, "env_invalid", raw);
    assert.match(setting.reason, /保留默认/);
  }
});

test("toolOutputBudget: 开关关闭时返回的就是常量对象本身（零差异、零开销）", () => {
  assert.equal(toolOutputBudget("read", {}), READ_TOOL_OUTPUT_BUDGET);
  assert.equal(toolOutputBudget("bash", {}), DEFAULT_TOOL_OUTPUT_BUDGET);
  assert.equal(toolOutputBudget(undefined, {}), DEFAULT_TOOL_OUTPUT_BUDGET);
});

test("toolOutputBudget: 开关打开时只改 budget，工具名分档不变", () => {
  const env = { PIFORGE_TOOL_OUTPUT_CHARS: "2000" };
  const read = toolOutputBudget("read", env);
  const bash = toolOutputBudget("bash", env);
  assert.equal(read.maxChars, 2_000);
  assert.equal(bash.maxChars, 2_000);
  // read 档仍然"头大尾小"，bash 档仍然头尾对称
  assert.ok(read.headChars > read.tailChars);
  assert.equal(bash.headChars, bash.tailChars);
});

test("withCharsLimit: 头/尾/行数按比例缩放，且不超过新上限", () => {
  const scaled = withCharsLimit(DEFAULT_TOOL_OUTPUT_BUDGET, 2_000);
  assert.equal(scaled.maxChars, 2_000);
  assert.equal(scaled.maxBytes, 2_000);
  assert.equal(scaled.headChars, 750);
  assert.equal(scaled.tailChars, 750);
  assert.equal(scaled.maxLines, 30);
  assert.ok(scaled.headChars + scaled.tailChars <= scaled.maxChars);
});

test("withCharsLimit: 上限不变时原样返回同一对象", () => {
  assert.equal(withCharsLimit(DEFAULT_TOOL_OUTPUT_BUDGET, DEFAULT_TOOL_OUTPUT_BUDGET.maxChars), DEFAULT_TOOL_OUTPUT_BUDGET);
});

test("shouldPersistToolOutput: 默认阈值不变；开关打开后 2000 字符就落盘", () => {
  assert.equal(shouldPersistToolOutput("x".repeat(3_999)), false);
  assert.equal(shouldPersistToolOutput("x".repeat(4_001)), true);
  // 走 env 的那条路径（默认参数会读 process.env，这里显式传预算，避免测试受环境影响）
  const tight = toolOutputBudget(undefined, { PIFORGE_TOOL_OUTPUT_CHARS: "2000" });
  assert.equal(shouldPersistToolOutput("x".repeat(2_001), undefined, tight), true);
  assert.equal(shouldPersistToolOutput("x".repeat(1_999), undefined, tight), false);
});
