import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HISTORY_DEFAULT_LIMIT,
  TOOL_OUTPUT_MAX_BYTES,
  TOOL_OUTPUT_MAX_LINES,
  buildToolOutputPreview,
  countLines,
  isToolOutputPath,
  persistToolOutput,
  readToolOutputPage,
  sanitizeToolCallId,
  shouldPersistToolOutput,
  toolHistoryHint,
  toolOutputFilePath,
} from "./tool-outputs.ts";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

function lines(count: number, prefix = "line"): string {
  return Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join("\n");
}

test("thresholds cover bytes and lines", () => {
  assert.equal(shouldPersistToolOutput("short output"), false);
  assert.equal(shouldPersistToolOutput("x".repeat(TOOL_OUTPUT_MAX_BYTES + 1)), true);
  assert.equal(shouldPersistToolOutput(lines(TOOL_OUTPUT_MAX_LINES + 1)), true);
  assert.equal(countLines("a\nb\n"), 2);
  assert.equal(countLines("a\nb"), 2);
  assert.equal(countLines(""), 0);
});

test("preview keeps the head and tail and appends the history hint", () => {
  const full = lines(100);
  const preview = buildToolOutputPreview(full, "call-42");
  assert.match(preview.text, /line 1\n/);
  assert.match(preview.text, /line 40/);
  assert.match(preview.text, /line 61/);
  assert.match(preview.text, /line 100/);
  assert.doesNotMatch(preview.text, /line 50/);
  assert.match(preview.text, /已省略 20 行/);
  assert.ok(preview.text.includes(toolHistoryHint("call-42")));
  assert.match(preview.text, /toolCallId: call-42, offset: 0, limit: 200/);
  assert.equal(preview.totalLines, 100);
  assert.equal(preview.previewLines, 80);
  assert.equal(preview.omittedLines, 20);
});

test("very long single lines fall back to a character window", () => {
  const full = `${"a".repeat(20_000)}\n${"b".repeat(20_000)}`;
  const preview = buildToolOutputPreview(full, "long");
  assert.match(preview.text, /已省略 \d+ 个字符/);
  assert.match(preview.text, /toolCallId: long/);
  assert.ok(preview.text.length < 20_000);
});

test("persist writes the full text under the session tool-outputs folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-tool-outputs-"));
  try {
    const sessionDir = join(dir, "sessions", "project");
    const full = lines(4_000);
    const result = persistToolOutput({
      sessionDir,
      sessionId: "session-1",
      toolCallId: "call-1",
      text: full,
    });
    assert.ok(result);
    const expected = join(sessionDir, "tool-outputs", "session-1", "call-1.log");
    assert.equal(result.marker.file, expected);
    assert.equal(existsSync(expected), true);
    assert.equal(readFileSync(expected, "utf-8"), full);
    assert.equal(result.marker.lines, 4_000);
    assert.ok(result.marker.bytes > TOOL_OUTPUT_MAX_BYTES);
    assert.match(result.previewText, /toolCallId: call-1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pi's bash full-output file wins over the truncated text", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-tool-outputs-full-"));
  try {
    const sessionDir = join(dir, "sessions", "project");
    const fullPath = join(dir, "bash-full.log");
    const full = lines(3_000);
    writeFileSync(fullPath, full);
    const result = persistToolOutput({
      sessionDir,
      sessionId: "session-1",
      toolCallId: "call-bash",
      text: "last 10 lines only",
      fullOutputPath: fullPath,
    });
    assert.ok(result);
    assert.equal(readFileSync(result.marker.file, "utf-8"), full);
    assert.equal(result.marker.lines, 3_000);
    assert.doesNotMatch(result.previewText, /last 10 lines only/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("small results are not persisted", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-tool-outputs-small-"));
  try {
    const result = persistToolOutput({
      sessionDir: dir,
      sessionId: "session-1",
      toolCallId: "call-small",
      text: "hello",
    });
    assert.equal(result, null);
    assert.equal(existsSync(join(dir, "tool-outputs")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pagination reads windows and reports totals", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-tool-outputs-pages-"));
  try {
    const file = join(dir, "page.log");
    writeFileSync(file, lines(250));

    const first = await readToolOutputPage(file, 0, 100);
    assert.equal(first.totalLines, 250);
    assert.equal(first.text.split("\n").length, 100);
    assert.match(first.text, /^line 1\n/);
    assert.match(first.text, /line 100$/);
    assert.equal(first.hasMore, true);

    const second = await readToolOutputPage(file, 200, 100);
    assert.equal(second.text.split("\n").length, 50);
    assert.match(second.text, /^line 201\n/);
    assert.equal(second.hasMore, false);

    const beyond = await readToolOutputPage(file, 500, 100);
    assert.equal(beyond.text, "");
    assert.equal(beyond.totalLines, 250);
    assert.equal(beyond.hasMore, false);

    await assert.rejects(() => readToolOutputPage(join(dir, "missing.log"), 0, 10));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tool call ids are sanitized for the filesystem", () => {
  assert.equal(sanitizeToolCallId("call-1"), "call-1");
  assert.equal(sanitizeToolCallId("parent/1"), "parent_1");
  assert.equal(sanitizeToolCallId("../../etc/passwd"), "etc_passwd");
  assert.equal(sanitizeToolCallId(""), "tool-call");
  assert.equal(sanitizeToolCallId("..."), "tool-call");
});

test("only host-owned persisted output paths are accepted", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-tool-outputs-paths-"));
  const previous = process.env[AGENT_DIR_ENV];
  process.env[AGENT_DIR_ENV] = dir;
  try {
    const sessionDir = join(dir, "sessions", "project");
    const file = toolOutputFilePath(sessionDir, "session-1", "call-1");
    mkdirSync(join(sessionDir, "tool-outputs", "session-1"), { recursive: true });
    writeFileSync(file, "x");
    assert.equal(isToolOutputPath(file), true);

    const outside = join(tmpdir(), "not-a-tool-output.log");
    assert.equal(isToolOutputPath(outside), false);
    assert.equal(isToolOutputPath(join(sessionDir, "tool-outputs", "session-1", "call-2.txt")), false);
    assert.equal(isToolOutputPath(join(sessionDir, "project", "call-3.log")), false);
    assert.equal(isToolOutputPath(""), false);
  } finally {
    if (previous === undefined) delete process.env[AGENT_DIR_ENV];
    else process.env[AGENT_DIR_ENV] = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("default page size and hint stay in sync", () => {
  assert.equal(HISTORY_DEFAULT_LIMIT, 200);
  assert.match(toolHistoryHint("id"), /offset: 0, limit: 200/);
});
