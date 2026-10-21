import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TOOL_OUTPUT_BUDGET,
  READ_TOOL_OUTPUT_BUDGET,
  TRUNCATION_HINT,
  countTextLines,
  exceedsToolOutputBudget,
  toolOutputBudget,
  truncationNotice,
  truncateToolOutput,
} from "./tool-output-budget.ts";

function lines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");
}

test("budgets are the documented hard caps", () => {
  assert.equal(DEFAULT_TOOL_OUTPUT_BUDGET.maxLines, 100);
  assert.equal(DEFAULT_TOOL_OUTPUT_BUDGET.maxBytes, 8 * 1024);
  assert.equal(READ_TOOL_OUTPUT_BUDGET.maxLines, 300);
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
  const text = lines(100);
  const result = truncateToolOutput(text);
  assert.equal(result.truncated, false);
  assert.equal(result.text, text);
  assert.equal(result.totalLines, 100);
});

test("over-long output keeps head and tail and states the real total", () => {
  const text = lines(1_000);
  const result = truncateToolOutput(text);
  assert.equal(result.truncated, true);
  assert.equal(result.truncatedBy, "lines");
  assert.equal(result.totalLines, 1_000);
  assert.match(result.text, /^line 1\n/);
  assert.match(result.text, /\[输出过长已截断，共 1000 行\]/);
  assert.ok(result.text.includes(TRUNCATION_HINT), "必须带上 grep/sed 的续读引导");
  assert.match(result.text, /line 1000$/);
  assert.doesNotMatch(result.text, /line 500/);
  assert.ok(
    Buffer.byteLength(result.text, "utf8") < Buffer.byteLength(text, "utf8") / 4,
    "截断后应显著小于原文",
  );
});

test("byte cap wins even when the line count is small", () => {
  const oneLongLine = "x".repeat(40 * 1024);
  const result = truncateToolOutput(oneLongLine);
  assert.equal(result.truncated, true);
  assert.equal(result.truncatedBy, "bytes");
  assert.ok(Buffer.byteLength(result.text, "utf8") <= DEFAULT_TOOL_OUTPUT_BUDGET.maxBytes + 64);
  assert.match(result.text, /输出过长已截断/);
});

test("read budget keeps the head only and stays continuous", () => {
  const text = lines(1_000);
  const result = truncateToolOutput(text, READ_TOOL_OUTPUT_BUDGET);
  assert.match(result.text, /^line 1\n/);
  assert.match(result.text, /line 300/);
  assert.doesNotMatch(result.text, /line 900/);
  assert.match(result.text, /共 1000 行/);
});

test("pi's pagination hint survives truncation", () => {
  const text = `${lines(800)}\n\n[Showing lines 1-800 of 5000. Use offset=801 to continue.]`;
  const result = truncateToolOutput(text, READ_TOOL_OUTPUT_BUDGET);
  assert.equal(result.totalLines, 802);
  assert.match(result.text, /Use offset=801 to continue/);
  // 提示必须还在正文之后，不能被截掉。
  assert.ok(result.text.indexOf("Use offset=801") > result.text.indexOf("输出过长已截断"));
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
    (twice.text.match(/输出过长已截断/g) ?? []).length,
    1,
    "二次裁剪不应叠加说明块",
  );
});

test("exceedsToolOutputBudget mirrors the two limits", () => {
  assert.equal(exceedsToolOutputBudget(lines(99)), false);
  assert.equal(exceedsToolOutputBudget(lines(101)), true);
  assert.equal(exceedsToolOutputBudget("y".repeat(9 * 1024)), true);
});

test("truncation notice wording is stable", () => {
  assert.equal(
    truncationNotice(1_234, DEFAULT_TOOL_OUTPUT_BUDGET),
    "[输出过长已截断，共 1234 行]（已保留前 40 行与后 40 行）",
  );
  assert.equal(
    truncationNotice(1_234, READ_TOOL_OUTPUT_BUDGET),
    "[输出过长已截断，共 1234 行]（已保留前 300 行）",
  );
  assert.match(TRUNCATION_HINT, /如需查看完整内容，请使用 grep、sed 等工具分段读取/);
});
