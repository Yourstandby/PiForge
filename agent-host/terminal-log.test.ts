import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  TERMINAL_MAX_BLOCKS,
  appendShellOutput,
  clearTerminalLog,
  finishShellBlock,
  listTerminalBlocks,
  onTerminalLogChange,
  resetTerminalLogForTest,
  setShellOutput,
  startShellBlock,
} from "./terminal-log.ts";
import { createDesktopTerminalFactory } from "./desktop-terminal-extension.ts";

test.beforeEach(() => resetTerminalLogForTest());
test.afterEach(() => resetTerminalLogForTest());

function createExtension() {
  return createDesktopTerminalFactory({ getCwd: () => "D:/proj" });
}

test("shell block starts running and finishes with ANSI text intact", () => {
  startShellBlock({ id: "call-1", command: "npm test", cwd: "/repo" });
  const running = listTerminalBlocks();
  assert.equal(running.length, 1);
  assert.equal(running[0].status, "running");
  assert.equal(running[0].title, "npm test");
  assert.equal(running[0].cwd, "/repo");

  const done = finishShellBlock({ id: "call-1", text: "\u001b[32mok\u001b[0m", status: "ok" });
  assert.ok(done);
  assert.equal(done.status, "ok");
  assert.equal(done.text, "\u001b[32mok\u001b[0m");
});

test("streaming output appends and is bounded", () => {
  startShellBlock({ id: "call-2", command: "yes" });
  appendShellOutput("call-2", "a".repeat(70_000));
  const block = listTerminalBlocks()[0];
  assert.ok(block.text.length <= 60_000);
});

test("streaming snapshots replace text and the final result wins", () => {
  startShellBlock({ id: "call-5", command: "npm run dev" });
  setShellOutput("call-5", "first");
  assert.equal(listTerminalBlocks()[0].text, "first");
  setShellOutput("call-5", "first\nsecond");
  assert.equal(listTerminalBlocks()[0].text, "first\nsecond");
  finishShellBlock({ id: "call-5", text: "first\nsecond\ndone", status: "ok" });
  assert.equal(listTerminalBlocks()[0].text, "first\nsecond\ndone");
});

test("blocks are capped to the ring size", () => {
  for (let i = 0; i < TERMINAL_MAX_BLOCKS + 5; i += 1) {
    startShellBlock({ id: `call-${i}`, command: `echo ${i}` });
  }
  const blocks = listTerminalBlocks();
  assert.equal(blocks.length, TERMINAL_MAX_BLOCKS);
  assert.equal(blocks[blocks.length - 1].title, `echo ${TERMINAL_MAX_BLOCKS + 4}`);
});

test("listeners fire on change and clear empties the log", () => {
  let calls = 0;
  const unsubscribe = onTerminalLogChange(() => {
    calls += 1;
  });
  startShellBlock({ id: "call-3", command: "ls" });
  finishShellBlock({ id: "call-3", text: "x", status: "ok" });
  assert.equal(calls, 2);

  clearTerminalLog();
  assert.equal(listTerminalBlocks().length, 0);
  unsubscribe();
  startShellBlock({ id: "call-4", command: "pwd" });
  assert.equal(calls, 3);
});

test("extension mirrors bash tool calls into the log", () => {
  const handlers = new Map<string, (event: unknown) => unknown>();
  const pi = {
    on: (name: string, handler: (event: unknown) => unknown) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    registerTool: () => {},
  } as unknown as ExtensionAPI;

  createExtension()(pi);

  handlers.get("tool_call")?.({
    type: "tool_call",
    toolCallId: "t1",
    toolName: "bash",
    input: { command: "npm run build" },
  });
  handlers.get("tool_execution_update")?.({
    type: "tool_execution_update",
    toolCallId: "t1",
    toolName: "bash",
    args: {},
    partialResult: { content: [{ type: "text", text: "building…" }] },
  });
  assert.equal(listTerminalBlocks()[0].text, "building…");

  handlers.get("tool_result")?.({
    type: "tool_result",
    toolCallId: "t1",
    toolName: "bash",
    input: {},
    content: [{ type: "text", text: "\u001b[31mfail\u001b[0m" }],
    isError: true,
  });

  const [block] = listTerminalBlocks();
  assert.equal(block.title, "npm run build");
  assert.equal(block.cwd, "D:/proj");
  assert.equal(block.status, "error");
  assert.equal(block.text, "\u001b[31mfail\u001b[0m");
});

test("extension ignores non-shell tools", () => {
  const handlers = new Map<string, (event: unknown) => unknown>();
  const pi = {
    on: (name: string, handler: (event: unknown) => unknown) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    registerTool: () => {},
  } as unknown as ExtensionAPI;

  createExtension()(pi);
  handlers.get("tool_call")?.({
    type: "tool_call",
    toolCallId: "t2",
    toolName: "read",
    input: { path: "a.ts" },
  });
  assert.equal(listTerminalBlocks().length, 0);
});
