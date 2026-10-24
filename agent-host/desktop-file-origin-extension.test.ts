import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "./sdk-adapter.ts";
import {
  createDesktopFileOriginFactory,
  desktopFileOriginInlineExtension,
  emptyFileOriginStats,
  targetPathOf,
} from "./desktop-file-origin-extension.ts";
import { createLedgerState } from "./cross-session-ledger.ts";
import path from "node:path";

const CWD = path.resolve("/repo");
const FILE = "src/a.ts";
const NOW = 1_700_000_000_000;

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function harness(options: { enabled?: () => boolean; now?: () => number } = {}) {
  const handlers = new Map<string, Handler>();
  const ledger = createLedgerState();
  const factory = createDesktopFileOriginFactory({
    ledger,
    now: options.now ?? (() => NOW),
    enabled: options.enabled,
  });
  factory({
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
    },
  } as never);
  const fire = (event: Record<string, unknown>, ctx: Partial<ExtensionContext>) =>
    handlers.get("tool_result")!(
      { type: "tool_result", toolCallId: "call-1", isError: false, content: [{ type: "text", text: "ok" }], ...event },
      { cwd: CWD, ...ctx } as ExtensionContext
    ) as
      | { content: Array<{ type: string; text: string }> }
      | undefined;
  return { handlers, ledger, fire };
}

function ctxFor(sessionId: string, sessionName: string | null): Partial<ExtensionContext> {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionName: () => sessionName ?? undefined,
    } as never,
  };
}

test("inline extension is named and exposes a factory", () => {
  const ext = desktopFileOriginInlineExtension();
  assert.equal(typeof ext, "object");
  assert.equal("name" in ext && ext.name, "desktop-file-origin");
  assert.equal("factory" in ext && typeof ext.factory, "function");
  assert.deepEqual(emptyFileOriginStats(), { touchesRecorded: 0, readNotes: 0, overwriteNotes: 0 });
});

test("only path-like inputs are attributed", () => {
  assert.equal(targetPathOf({ path: " src/a.ts " }), "src/a.ts");
  assert.equal(targetPathOf({ path: "" }), null);
  assert.equal(targetPathOf({ command: "ls" }), null);
  assert.equal(targetPathOf(null), null);
});

test("a write is recorded and surfaces as a note for another session's read", () => {
  const { fire, ledger } = harness();

  const writeResult = fire(
    { toolName: "write", input: { path: FILE, content: "x" } },
    ctxFor("sess-a", "主干")
  );
  assert.equal(writeResult, undefined, "第一次写入没有前序改动，不加提示");
  assert.equal(ledger.touches.length, 1);
  assert.equal(ledger.touches[0].sessionId, "sess-a");

  const readResult = fire(
    { toolName: "read", input: { path: FILE } },
    ctxFor("sess-b", "外围")
  );
  assert.ok(readResult);
  const text = readResult!.content.at(-1)!.text;
  assert.match(text, /src\/a\.ts/);
  assert.match(text, /主干/);
  assert.match(text, /git diff -- src\/a\.ts/);
  // 原始内容必须完整保留，署名只是追加一行。
  assert.equal(readResult!.content[0].text, "ok");
});

test("own session reads never get the note", () => {
  const { fire } = harness();
  fire({ toolName: "edit", input: { path: FILE, edits: [] } }, ctxFor("sess-a", "主干"));
  const readResult = fire({ toolName: "read", input: { path: FILE } }, ctxFor("sess-a", "主干"));
  assert.equal(readResult, undefined);
});

test("overwriting a file another session touched adds an alignment note", () => {
  const { fire, ledger } = harness();
  fire({ toolName: "write", input: { path: FILE, content: "a" } }, ctxFor("sess-a", "主干"));
  const editResult = fire(
    { toolName: "edit", input: { path: FILE, edits: [] } },
    ctxFor("sess-b", "外围")
  );
  assert.ok(editResult);
  assert.match(editResult!.content.at(-1)!.text, /git diff -- src\/a\.ts/);
  assert.equal(ledger.touches[0].sessionId, "sess-b", "台账更新为最新写入方");
});

test("errors and non-file tools pass through untouched", () => {
  const { fire, ledger } = harness();
  const failed = fire(
    { toolName: "write", input: { path: FILE, content: "a" }, isError: true, content: [{ type: "text", text: "boom" }] },
    ctxFor("sess-a", "主干")
  );
  assert.equal(failed, undefined);
  assert.equal(ledger.touches.length, 0, "失败的写入不记台账");

  const bash = fire(
    { toolName: "bash", input: { path: FILE } },
    ctxFor("sess-a", "主干")
  );
  assert.equal(bash, undefined);
});

test("notes can be switched off", () => {
  const { fire, ledger } = harness({ enabled: () => false });
  fire({ toolName: "write", input: { path: FILE, content: "a" } }, ctxFor("sess-a", "主干"));
  assert.equal(ledger.touches.length, 0);
  const readResult = fire({ toolName: "read", input: { path: FILE } }, ctxFor("sess-b", "外围"));
  assert.equal(readResult, undefined);
});
