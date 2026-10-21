import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "./sdk-adapter.ts";
import { createDesktopToolOutputFactory } from "./desktop-tool-output-extension.ts";
import { TOOL_HISTORY_TOOL_NAME } from "./tool-outputs.ts";

type Handler = (event: unknown, ctx?: unknown) => unknown;

interface ToolDefinition {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown }>;
}

function setup(sessionDir: string, sessionId = "session-1") {
  const handlers = new Map<string, Handler>();
  const tools: ToolDefinition[] = [];
  const pi = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    registerTool: (definition: ToolDefinition) => {
      tools.push(definition);
    },
    setActiveTools: () => {},
    getAllTools: () => [],
    getActiveTools: () => [],
  } as unknown as ExtensionAPI;
  createDesktopToolOutputFactory()(pi);
  const ctx = { sessionManager: { getSessionDir: () => sessionDir, getSessionId: () => sessionId } };
  return { handlers, tools, ctx };
}

function resultEvent(toolName: string, text: string, toolCallId = "call-big", details?: unknown) {
  return {
    type: "tool_result",
    toolName,
    toolCallId,
    input: { command: "big" },
    content: [{ type: "text", text }],
    isError: false,
    ...(details !== undefined ? { details } : {}),
  };
}

function lineText(count: number): string {
  return Array.from({ length: count }, (_, index) => `output line ${index + 1}`).join("\n");
}

test("large tool output is replaced by a preview and persisted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-tool-output-ext-"));
  try {
    const sessionDir = join(dir, "sessions", "project");
    const { handlers, ctx } = setup(sessionDir);
    const full = lineText(3_000);
    const result = (await handlers.get("tool_result")?.(resultEvent("bash", full), ctx)) as {
      content: Array<{ type: string; text?: string }>;
      details: { toolOutput?: { file: string; lines: number; kind: string } };
    };
    assert.ok(result, "large output must be rewritten");
    assert.equal(result.content.length, 1);
    assert.match(result.content[0].text ?? "", /toolCallId: call-big, offset: 0, limit: 200/);
    assert.doesNotMatch(result.content[0].text ?? "", /output line 1500/);
    const marker = result.details.toolOutput;
    assert.ok(marker);
    assert.equal(marker.kind, "tool-output");
    assert.equal(marker.lines, 3_000);
    assert.equal(existsSync(marker.file), true);
    assert.equal(readFileSync(marker.file, "utf-8"), full);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("small output is left untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-tool-output-ext-small-"));
  try {
    const { handlers, ctx } = setup(join(dir, "sessions", "project"));
    const result = await handlers.get("tool_result")?.(resultEvent("bash", "hello"), ctx);
    assert.equal(result, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("images survive the content rewrite", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-tool-output-ext-image-"));
  try {
    const { handlers, ctx } = setup(join(dir, "sessions", "project"));
    const event = {
      type: "tool_result",
      toolName: "web_preview",
      toolCallId: "shot-1",
      input: {},
      content: [
        { type: "text", text: lineText(2_500) },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ],
      isError: false,
    };
    const result = (await handlers.get("tool_result")?.(event, ctx)) as {
      content: Array<{ type: string }>;
    };
    assert.equal(result.content.filter((block) => block.type === "image").length, 1);
    assert.equal(result.content.filter((block) => block.type === "text").length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tool_history_get is exempt and reads pages back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-tool-output-history-"));
  try {
    const sessionDir = join(dir, "sessions", "project");
    const { handlers, tools, ctx } = setup(sessionDir);
    const full = lineText(2_500);
    await handlers.get("tool_result")?.(resultEvent("bash", full), ctx);

    // Reading history must not persist its own output.
    const historyToolResult = await handlers.get("tool_result")?.(
      resultEvent(TOOL_HISTORY_TOOL_NAME, "restored text"),
      ctx,
    );
    assert.equal(historyToolResult, undefined);

    const tool = tools.find((candidate) => candidate.name === TOOL_HISTORY_TOOL_NAME);
    assert.ok(tool, "tool_history_get must be registered");

    const first = await tool.execute("history-1", { toolCallId: "call-big", offset: 0, limit: 200 }, undefined, undefined, ctx);
    const firstText = first.content[0]?.text ?? "";
    assert.match(firstText, /lines 1-200 of 2500/);
    assert.match(firstText, /^Tool output for call-big/);
    assert.match(firstText, /output line 1\n/);
    assert.match(firstText, /output line 200/);
    assert.match(firstText, /Next page: offset 200, limit 200/);

    const second = await tool.execute("history-2", { toolCallId: "call-big", offset: 2_400, limit: 200 }, undefined, undefined, ctx);
    const secondText = second.content[0]?.text ?? "";
    assert.match(secondText, /lines 2401-2500 of 2500/);
    assert.match(secondText, /End of output/);
    assert.doesNotMatch(secondText, /Next page/);

    const missing = await tool.execute("history-3", { toolCallId: "unknown-call" }, undefined, undefined, ctx);
    assert.match(missing.content[0]?.text ?? "", /No persisted output/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read output is capped by the file-content budget instead of being exempt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-tool-output-read-"));
  try {
    const sessionDir = join(dir, "sessions", "project");
    const { handlers, ctx } = setup(sessionDir);
    const result = (await handlers.get("tool_result")?.(
      resultEvent("read", lineText(3_000)),
      ctx,
    )) as { content: Array<{ type: string; text?: string }>; details: Record<string, unknown> };
    assert.ok(result, "a 3000-line read must be trimmed");
    const text = result.content[0]?.text ?? "";
    assert.match(text, /\[输出过长已截断，共 3000 行\]/);
    assert.match(text, /请使用 grep、sed 等工具分段读取/);
    assert.match(text, /offset=301/);
    assert.match(text, /output line 1\n/);
    assert.doesNotMatch(text, /output line 3000/);
    // 源文件就在磁盘上：read 只裁剪，不落盘。
    assert.equal(existsSync(join(sessionDir, "tool-outputs")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read output that fits the budget is left untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-tool-output-read-small-"));
  try {
    const { handlers, ctx } = setup(join(dir, "sessions", "project"));
    const result = await handlers.get("tool_result")?.(resultEvent("read", lineText(50)), ctx);
    assert.equal(result, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read keeps pi's own pagination hint after truncation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-tool-output-read-page-"));
  try {
    const { handlers, ctx } = setup(join(dir, "sessions", "project"));
    const body = `${lineText(1_000)}\n\n[Showing lines 1-1000 of 4000. Use offset=1001 to continue.]`;
    const result = (await handlers.get("tool_result")?.(resultEvent("read", body), ctx)) as {
      content: Array<{ type: string; text?: string }>;
    };
    const text = result.content[0]?.text ?? "";
    assert.match(text, /Use offset=1001 to continue/);
    assert.match(text, /\[输出过长已截断，共 1002 行\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bash full-output path is preferred over the truncated text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-tool-output-bash-"));
  try {
    const sessionDir = join(dir, "sessions", "project");
    const fullPath = join(dir, "bash-full.log");
    const full = lineText(2_500);
    writeFileSync(fullPath, full);
    const { handlers, ctx } = setup(sessionDir);
    const result = (await handlers.get("tool_result")?.(
      resultEvent("bash", "tail only", "call-bash", { fullOutputPath: fullPath }),
      ctx,
    )) as { details: { toolOutput?: { file: string; lines: number } } };
    assert.ok(result);
    assert.equal(result.details.toolOutput?.lines, 2_500);
    assert.equal(readFileSync(result.details.toolOutput!.file, "utf-8"), full);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
