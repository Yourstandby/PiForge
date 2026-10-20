import test from "node:test";
import assert from "node:assert/strict";
import {
  BROWSER_CONNECTED_WINDOW_MS,
  BROWSER_MAX_PENDING_COMMANDS,
  BROWSER_TEXT_LIMIT,
  getBrowserSnapshot,
  isBrowserPanelConnected,
  pushBrowserSnapshot,
  recordBrowserPoll,
  requestBrowserCommand,
  resetBrowserBridgeForTest,
  resolveBrowserCommand,
  takeBrowserCommands,
} from "./browser-bridge.ts";

test.beforeEach(() => resetBrowserBridgeForTest());
test.afterEach(() => resetBrowserBridgeForTest());

test("snapshot keeps page data and reports truncation", () => {
  const snapshot = pushBrowserSnapshot({
    url: "http://localhost:5173/",
    title: "Dev",
    text: "x".repeat(BROWSER_TEXT_LIMIT + 10),
    viewport: { width: 900.4, height: 700.6 },
  });
  assert.ok(snapshot);
  assert.equal(snapshot.url, "http://localhost:5173/");
  assert.equal(snapshot.text.length, BROWSER_TEXT_LIMIT);
  assert.equal(snapshot.truncated, true);
  assert.deepEqual(snapshot.viewport, { width: 900, height: 701 });
  assert.deepEqual(getBrowserSnapshot(), snapshot);
});

test("snapshot without url and text is ignored", () => {
  assert.equal(pushBrowserSnapshot({ url: "", text: "" }), null);
  assert.equal(getBrowserSnapshot(), null);
});

test("panel counts as connected only while it keeps polling", () => {
  assert.equal(isBrowserPanelConnected(1_000), false);
  recordBrowserPoll(1_000);
  assert.equal(isBrowserPanelConnected(1_000 + BROWSER_CONNECTED_WINDOW_MS), true);
  assert.equal(isBrowserPanelConnected(1_000 + BROWSER_CONNECTED_WINDOW_MS + 1), false);
});

test("commands are drained once and resolved through the posted result", async () => {
  recordBrowserPoll();
  const pending = requestBrowserCommand({ kind: "read" }, 5_000);
  const [command] = takeBrowserCommands();
  assert.equal(command.kind, "read");
  assert.deepEqual(takeBrowserCommands(), []);

  resolveBrowserCommand({ id: command.id, ok: true, text: "hello", url: "http://localhost/" });
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.text, "hello");
  // A duplicate result for the same id is ignored.
  assert.equal(resolveBrowserCommand({ id: command.id, ok: true, text: "again" }), false);
});

test("commands time out when no renderer answers", async () => {
  const result = await requestBrowserCommand({ kind: "screenshot" }, 30);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /did not answer/);
});

test("pending queue is bounded", async () => {
  const waits = Array.from({ length: BROWSER_MAX_PENDING_COMMANDS + 2 }, () =>
    requestBrowserCommand({ kind: "read" }, 5_000),
  );
  const commands = takeBrowserCommands();
  assert.equal(commands.length, BROWSER_MAX_PENDING_COMMANDS);
  // The two oldest requests were rejected by the queue cap.
  const results = await Promise.all(waits.slice(0, 2));
  assert.ok(results.every((result) => result.ok === false));
  for (const command of commands) resolveBrowserCommand({ id: command.id, ok: true });
});
