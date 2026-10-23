import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AgentSessionWrapper, getRpcSessionRegistry, startRpcSession } from "./rpc-manager.ts";
import { PLAN_TOOLS } from "../lib/approval-policy.ts";

type SubscribeFn = (cb: (event: unknown) => void) => () => void;

const source = readFileSync(new URL("./rpc-manager.ts", import.meta.url), "utf8");

// destroy() is async (Task B3). After mock.timers.tick() fires the idle
// timer, the destroy Promise needs a microtask cycle to settle before
// onDestroy callbacks become observable. setImmediate flushes the microtask
// queue without itself being mocked by mock.timers.
const flushMicrotasks = (): Promise<void> => new Promise((r) => setImmediate(r));

test("startRpcSession does not pass a hardcoded default tool allowlist", () => {
  assert.doesNotMatch(source, /const allCodingToolNames = \[[^\]]+\]/);
  assert.match(source, /noTools: "builtin"/);
  assert.match(source, /effectiveToolsForMode/);
  assert.match(
    source,
    /setActiveToolsByName\(canonicalToolOrder\(\[\.\.\.effectiveTools, \.\.\.inner\.getActiveToolNames\(\)\]\)\)/,
  );
});

test("startRpcSession registers desktopLtmInlineExtension", () => {
  assert.match(source, /desktopLtmInlineExtension\(\{\s*getCwd:\s*\(\)\s*=>\s*cwd\s*\}\)/);
});

test("memory is an on-demand domain: the start path no longer force-declares it", () => {
  // v0.8.3 第 3 步：memory 改成 tool_search 激活的按需域，声明集合由
  // desktop-runtime-tools 统一决定；plan 模式的只读 recall 由 PLAN_TOOLS 承担。
  assert.match(source, /const effectiveTools = effectiveToolsForMode\(agentMode, toolPreset\)/);
  assert.doesNotMatch(source, /withMemoryTools\(/);
  assert.ok(PLAN_TOOLS.includes("memory"), "plan mode keeps the read-only memory facade");
});

function makeStubInner(overrides: {
  subscribe?: SubscribeFn;
  sessionManager?: unknown;
  model?: unknown;
  agent?: unknown;
  prompt?: (msg: string, opts?: unknown) => Promise<unknown>;
  steer?: (msg: string, imgs?: unknown) => Promise<unknown>;
  followUp?: (msg: string, imgs?: unknown) => Promise<unknown>;
  setActiveToolsByName?: (names: string[]) => void;
  abort?: () => Promise<void>;
  isStreaming?: boolean;
} = {}) {
  return {
    sessionId: "stub",
    sessionFile: "stub.jsonl",
    isStreaming: overrides.isStreaming ?? false,
    isCompacting: false,
    autoCompactionEnabled: false,
    autoRetryEnabled: false,
    model: overrides.model ?? null,
    getContextUsage: () => null,
    agent: overrides.agent ?? { state: { systemPrompt: "", thinkingLevel: "off" } },
    sessionManager: overrides.sessionManager ?? null,
    modelRuntime: { getModel: () => undefined },
    prompt: overrides.prompt ?? (() => Promise.resolve()),
    steer: overrides.steer ?? (() => Promise.resolve()),
    followUp: overrides.followUp ?? (() => Promise.resolve()),
    setActiveToolsByName: overrides.setActiveToolsByName ?? (() => {}),
    abort: overrides.abort ?? (async () => {}),
    getAllTools: () => [],
    getActiveToolNames: () => [],
    subscribe: overrides.subscribe ?? ((cb: (event: unknown) => void) => { void cb; return () => {}; }),
  } as never;
}

test("Codemode changes wait until the running turn settles", async () => {
  let receive: (event: unknown) => void = () => {};
  const inner = makeStubInner({ isStreaming: true, subscribe: cb => { receive = cb; return () => {}; } });
  const w = new AgentSessionWrapper(inner);
  w.initPolicy("full", "default", true);
  w.start();
  try {
    w.setCodemodeEnabled(false);
    assert.equal(w.modeRef.codemodeEnabled, true);
    receive({ type: "agent_settled" });
    assert.equal(w.modeRef.codemodeEnabled, false);
  } finally {
    await w.destroy();
  }
});

test("MCP resource changes reload before the next prompt and shutdown before disposal", async () => {
  const calls: string[] = [];
  const inner = Object.assign(makeStubInner({ prompt: async () => { calls.push("prompt"); } }), {
    reload: async () => { calls.push("reload"); },
    extensionRunner: { emit: async () => { calls.push("shutdown"); } },
    dispose: () => { calls.push("dispose"); },
  });
  const w = new AgentSessionWrapper(inner);
  w.start();
  w.requestResourceReload();
  await w.send({ type: "prompt", message: "test" });
  await w.destroy();
  assert.deepEqual(calls, ["reload", "prompt", "shutdown", "dispose"]);
});

test("wrapper is destroyed after 10 min of inactivity", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const w = new AgentSessionWrapper(makeStubInner());
    let destroyed = false;
    w.onDestroy(() => { destroyed = true; });
    w.start();

    mock.timers.tick(9 * 60 * 1000);
    assert.equal(destroyed, false, "should still be alive after 9 min");

    mock.timers.tick(60 * 1000);
    await flushMicrotasks();
    assert.equal(destroyed, true, "should be destroyed after 10 min");
  } finally {
    mock.timers.reset();
  }
});

test("keepAlive resets the idle timer", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const w = new AgentSessionWrapper(makeStubInner());
    let destroyed = false;
    w.onDestroy(() => { destroyed = true; });
    w.start();

    mock.timers.tick(9 * 60 * 1000);
    assert.equal(destroyed, false);

    w.keepAlive();

    mock.timers.tick(9 * 60 * 1000);
    assert.equal(destroyed, false, "should still be alive 9 min after keepAlive");

    mock.timers.tick(60 * 1000);
    await flushMicrotasks();
    assert.equal(destroyed, true, "should be destroyed 10 min after keepAlive");
  } finally {
    mock.timers.reset();
  }
});

test("events reset the idle timer (regression)", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let emittedCb: ((event: unknown) => void) | null = null;
    const inner = makeStubInner({
      subscribe: (cb) => { emittedCb = cb; return () => {}; },
    });
    const w = new AgentSessionWrapper(inner);
    let destroyed = false;
    w.onDestroy(() => { destroyed = true; });
    w.start();

    mock.timers.tick(9 * 60 * 1000);
    assert.equal(destroyed, false);

    emittedCb!({ type: "agent_start" });

    mock.timers.tick(9 * 60 * 1000);
    assert.equal(destroyed, false, "should still be alive 9 min after pi event");

    mock.timers.tick(60 * 1000);
    await flushMicrotasks();
    assert.equal(destroyed, true, "should be destroyed 10 min after last event");
  } finally {
    mock.timers.reset();
  }
});

test("keepAlive is a no-op on a destroyed wrapper", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const w = new AgentSessionWrapper(makeStubInner());
    let destroyed = false;
    w.onDestroy(() => { destroyed = true; });
    w.start();

    // Force destruction via idle timeout
    mock.timers.tick(10 * 60 * 1000);
    await flushMicrotasks();
    assert.equal(destroyed, true);

    // keepAlive after destroy must not schedule a new timer or throw.
    // If it scheduled a timer, ticking past 10 min would NOT cause
    // observable harm (the timer's destroy() is idempotent), but the
    // contract is: no-op on dead wrapper.
    w.keepAlive();
    mock.timers.tick(20 * 60 * 1000);
    await flushMicrotasks();
    // Still only one onDestroy call (the original). No error thrown.
    assert.equal(destroyed, true);
  } finally {
    mock.timers.reset();
  }
});

test("peekState does NOT reset the idle timer (regression for Task B2)", async () => {
  // Polling GET /api/sessions/[id]?includeState=1 calls peekState(). If it
  // reset the idle timer, any polling client would keep idle sessions alive
  // forever. We assert the opposite: a wrapper that has been idle for 9 min
  // is still destroyed at the 10-min mark even if peekState() was called
  // during that window.
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const w = new AgentSessionWrapper(makeStubInner());
    let destroyed = false;
    w.onDestroy(() => { destroyed = true; });
    w.start();

    mock.timers.tick(9 * 60 * 1000);
    assert.equal(destroyed, false, "should still be alive at 9 min");

    // A polling client observes state — this must NOT extend the lifetime.
    const snapshot = w.peekState();
    assert.equal(snapshot.sessionId, "stub");
    assert.equal(snapshot.isStreaming, false);

    mock.timers.tick(30 * 1000);
    assert.equal(destroyed, false, "should still be alive at 9:30 (only 30s since peek)");

    mock.timers.tick(30 * 1000);
    await flushMicrotasks();
    assert.equal(destroyed, true, "peekState must not reset the 10-min idle timer");
  } finally {
    mock.timers.reset();
  }
});

test("send({type:'get_state'}) DOES reset the idle timer (explicit control)", async () => {
  // Callers that intentionally drive the session use send(), which keeps the
  // wrapper alive. This guards the contract documented on peekState().
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const w = new AgentSessionWrapper(makeStubInner());
    let destroyed = false;
    w.onDestroy(() => { destroyed = true; });
    w.start();

    mock.timers.tick(9 * 60 * 1000);
    assert.equal(destroyed, false);

    const state = await w.send({ type: "get_state" });
    assert.equal((state as { sessionId: string }).sessionId, "stub");

    // 9 more minutes since the send() call — would cross 10 min if not reset.
    mock.timers.tick(9 * 60 * 1000);
    assert.equal(destroyed, false, "send({type:'get_state'}) should reset the idle timer");

    mock.timers.tick(60 * 1000);
    await flushMicrotasks();
    assert.equal(destroyed, true, "should be destroyed 10 min after last send");
  } finally {
    mock.timers.reset();
  }
});

test("peekState and send get_state return the same payload shape", async () => {
  const w = new AgentSessionWrapper(makeStubInner());
  const peeked = w.peekState();
  const sent = await w.send({ type: "get_state" });
  assert.deepEqual(peeked, sent, "peekState must mirror get_state payload");
});

// Defense-in-depth: if someone accidentally reintroduces resetIdleTimer into
// peekState (e.g. by copy-pasting send), this source-text assertion catches
// it at test time without needing to construct a live inner.
test("peekState source does not reference resetIdleTimer", () => {
  const peekFnMatch = source.match(/peekState\(\)[^{]*\{[\s\S]*?\n  \}/);
  assert.ok(peekFnMatch, "peekState method should exist in source");
  assert.doesNotMatch(peekFnMatch[0], /resetIdleTimer/);
});

test("fork returns {cancelled: true} for non-persisted session", async () => {
  const inner = makeStubInner({
    sessionManager: { isPersisted: () => false },
  });
  const w = new AgentSessionWrapper(inner);
  w.start();
  const result = await w.send({ type: "fork", entryId: "x" });
  assert.deepEqual(result, { cancelled: true });
});

// Task D4: fork must refuse when the underlying session file has been deleted
// (concurrent DELETE race). makeStubInner does not let callers override
// sessionFile, and mocking existsSync would require module mocking; the guard
// is a one-line stat check, so we assert on the source text (same pattern as
// the other source-contract tests in this file).
test("fork guards against deleted session file (source contract)", () => {
  assert.match(source, /import \{ existsSync \} from "fs"/);
  // The guard must sit between the isPersisted check and the entryId lookup,
  // so a racing DELETE is caught before any SessionManager.open() side effect.
  assert.match(
    source,
    /if \(!sessionManager\.isPersisted\(\)\) return \{ cancelled: true \};\s*\n\s*if \(!currentSessionFile\) throw new Error\([^)]*\);\s*\n[\s\S]*?if \(!existsSync\(currentSessionFile\)\) return \{ cancelled: true \};/
  );
});

// Task A6: fork failure must clean up the orphaned .jsonl file.
// `startRpcSession` is a same-module function that internally calls
// `createAgentSession` (from pi-coding-agent), which can't be injected via the
// stub inner, so a behavioral test that triggers its throw is infeasible without
// module mocking. We instead assert on the source text (same pattern as the
// first test in this file) that the cleanup contract is in place:
//   1. await startRpcSession is wrapped in try/catch
//   2. catch invalidates the cached path (so future lookups don't hit a dead id)
//   3. catch unlinks the orphan file (best-effort, swallows missing-file errors)
//   4. catch rethrows — the error must propagate; the old wrapper is NOT destroyed
test("fork cleans up orphan .jsonl file when startRpcSession throws (source contract)", () => {
  // The stale "next fork overwrites" rationale has been removed — the new file
  // name is a unique <timestamp>_<uuid>.jsonl and is never overwritten.
  assert.doesNotMatch(source, /next fork overwrites/);

  // unlink must be imported.
  assert.match(source, /import \{ unlink \} from "fs\/promises"/);

  // startRpcSession must be awaited inside a try block.
  assert.match(source, /try \{\s*\n\s*await startRpcSession\(/);

  // catch must best-effort unlink the orphan, then rethrow.
  assert.match(
    source,
    /await unlink\(newSessionFile\)\.catch\(\(\) => \{[^}]*\}\);\s*\n\s*throw err;/
  );

  // this.destroy() must NOT be reachable when startRpcSession throws — it lives
  // after the try/catch, so an error in the try block skips it (old wrapper
  // stays usable under the old id). destroy() is async (Task B3), so it must
  // be awaited here — the await also ensures the old wrapper is fully torn
  // down (unsubscribe + onDestroy callbacks) before send() returns.
  assert.match(source, /\}\s*\n\s*\n\s*await this\.destroy\(\);\s*\n\s*return \{ cancelled: false, newSessionId \};/);
});

// Task B3: destroy() must be async and await both the unsubscribe fn and
// onDestroy callbacks. The current pi subscribe() returns `() => void`, but
// if it ever returns an async cleanup fn (e.g. to release an underlying
// subscription), the old `this.unsubscribe?.()` without await would not wait
// for cleanup to finish before GC. Same reasoning for onDestroy callbacks —
// some may want to flush resources asynchronously.
test("destroy() awaits the unsubscribe fn and onDestroy callbacks", async () => {
  let unsubResolved = false;
  let cbResolved = false;
  // unsubscribe returns a Promise (simulates a future async cleanup fn).
  // TypeScript allows `() => Promise<void>` where `() => void` is expected.
  const unsubscribe = (): Promise<void> =>
    new Promise((resolve) =>
      setTimeout(() => {
        unsubResolved = true;
        resolve();
      }, 5)
    );
  const inner = makeStubInner({
    subscribe: () => unsubscribe as unknown as () => void,
  });
  const w = new AgentSessionWrapper(inner);
  w.start();
  w.onDestroy(
    () =>
      new Promise<void>((resolve) =>
        setTimeout(() => {
          cbResolved = true;
          resolve();
        }, 5)
      ) as unknown as void
  );

  await w.destroy();

  // Both the async unsubscribe and the async callback must have completed
  // before destroy()'s Promise resolved — that is the contract await gives us.
  assert.equal(unsubResolved, true, "destroy must await the async unsubscribe");
  assert.equal(cbResolved, true, "destroy must await async onDestroy callbacks");
  assert.equal(w.isAlive(), false);
});

test("destroy() swallows errors from the async unsubscribe (other callbacks still run)", async () => {
  // If unsubscribe throws (sync) or rejects (async), destroy must catch it
  // and continue running onDestroy callbacks — otherwise a failing
  // unsubscribe would leak the registered callbacks.
  let cbCalled = false;
  const unsubscribe = () => Promise.reject(new Error("unsubscribe boom"));
  const inner = makeStubInner({
    subscribe: () => unsubscribe as unknown as () => void,
  });
  const w = new AgentSessionWrapper(inner);
  w.start();
  w.onDestroy(() => {
    cbCalled = true;
  });

  await w.destroy();
  assert.equal(cbCalled, true, "onDestroy callbacks must run even if unsubscribe rejects");
  assert.equal(w.isAlive(), false);
});

test("destroy() is idempotent (async)", async () => {
  let cbCount = 0;
  const w = new AgentSessionWrapper(makeStubInner());
  w.onDestroy(() => {
    cbCount++;
  });
  w.start();

  await w.destroy();
  await w.destroy(); // second call must be a no-op (early return on !_alive)
  assert.equal(cbCount, 1, "onDestroy callback must fire exactly once");
  assert.equal(w.isAlive(), false);
});

test("destroy() aborts the inner agent session (M1)", async () => {
  let aborted = false;
  const inner = makeStubInner({
    abort: async () => {
      aborted = true;
    },
  });
  const w = new AgentSessionWrapper(inner);
  await w.destroy();
  assert.equal(
    aborted,
    true,
    "destroy() must terminate the inner pi agent loop so a forked/deleted session stops writing its .jsonl"
  );
});

// Source-text contract: guards all the Task B3 invariants at compile time so
// that an accidental revert (e.g. someone drops the await or the .catch on
// the idle timer) is caught without constructing a live inner.
test("destroy() source matches the Task B3 contract", () => {
  // destroy is declared `async destroy(): Promise<void>`
  assert.match(source, /async destroy\(\): Promise<void>/);
  // unsubscribe is awaited inside try/catch
  assert.match(
    source,
    /try \{\s*\n\s*await this\.unsubscribe\?\.\(\);\s*\n\s*\} catch \(err\) \{\s*\n\s*console\.error\("Error during unsubscribe:", err\);\s*\n\s*\}/
  );
  // onDestroy callbacks are awaited (so async callbacks work)
  assert.match(source, /await cb\(\)/);
  // idle timer callback must handle the now-Promise return — an unhandled
  // rejection inside setTimeout would crash the process.
  assert.match(
    source,
    /this\.destroy\(\)\.catch\(\(err\) => console\.error\("Error during idle destroy:", err\)\)/
  );
});

// ============================================================================
// Task D3: applyDeepSeekXhighWorkaround
// Isolated hack that forces state.thinkingLevel back to "xhigh" after
// setThinkingLevel clamps it to "high" for deepseek-compat models.
// ============================================================================

// The workaround is a private method; access it via a typed cast for testing.
function callDeepSeekWorkaround(w: AgentSessionWrapper, level: string): boolean {
  return (w as unknown as { applyDeepSeekXhighWorkaround(level: string): boolean })
    .applyDeepSeekXhighWorkaround(level);
}

test("applyDeepSeekXhighWorkaround: forces state.thinkingLevel back to xhigh on deepseek models", () => {
  // Simulate the post-clamp state: setThinkingLevel already ran and set "high".
  const state = { systemPrompt: "", thinkingLevel: "high" };
  const inner = makeStubInner({
    model: { id: "deepseek-reasoner", provider: "deepseek", compat: { thinkingFormat: "deepseek" } },
    agent: { state },
  });
  const w = new AgentSessionWrapper(inner);

  assert.equal(callDeepSeekWorkaround(w, "xhigh"), true);
  assert.equal(state.thinkingLevel, "xhigh", "state.thinkingLevel must be forced back to xhigh");
});

test("applyDeepSeekXhighWorkaround: no-op for non-deepseek thinking format", () => {
  const state = { systemPrompt: "", thinkingLevel: "high" };
  const inner = makeStubInner({
    model: { id: "gpt-5", provider: "openai", compat: { thinkingFormat: "openai" } },
    agent: { state },
  });
  const w = new AgentSessionWrapper(inner);

  assert.equal(callDeepSeekWorkaround(w, "xhigh"), false);
  assert.equal(state.thinkingLevel, "high", "state.thinkingLevel must not change for non-deepseek");
});

test("applyDeepSeekXhighWorkaround: no-op when level is not xhigh", () => {
  const state = { systemPrompt: "", thinkingLevel: "high" };
  const inner = makeStubInner({
    model: { id: "deepseek-reasoner", provider: "deepseek", compat: { thinkingFormat: "deepseek" } },
    agent: { state },
  });
  const w = new AgentSessionWrapper(inner);

  assert.equal(callDeepSeekWorkaround(w, "high"), false);
  assert.equal(state.thinkingLevel, "high", "state.thinkingLevel must not change for non-xhigh levels");
});

test("applyDeepSeekXhighWorkaround: no-op when model has no compat field", () => {
  const state = { systemPrompt: "", thinkingLevel: "high" };
  const inner = makeStubInner({
    model: { id: "plain-model", provider: "p" },
    agent: { state },
  });
  const w = new AgentSessionWrapper(inner);

  assert.equal(callDeepSeekWorkaround(w, "xhigh"), false);
  assert.equal(state.thinkingLevel, "high", "state.thinkingLevel must not change when compat is absent");
});

test("applyDeepSeekXhighWorkaround: no-op when agent.state is missing", () => {
  const inner = makeStubInner({
    model: { id: "deepseek-reasoner", provider: "deepseek", compat: { thinkingFormat: "deepseek" } },
    agent: { state: undefined },
  });
  const w = new AgentSessionWrapper(inner);

  assert.equal(callDeepSeekWorkaround(w, "xhigh"), false);
});

test("applyDeepSeekXhighWorkaround: no-op when model is null (default stub)", () => {
  const inner = makeStubInner(); // model defaults to null
  const w = new AgentSessionWrapper(inner);

  assert.equal(callDeepSeekWorkaround(w, "xhigh"), false);
});

// ============================================================================
// Task D5: agent_error emission on prompt/steer failures
// Pi-side failures used to only hit console.error (prompt) or only surface
// via the HTTP response (steer/follow_up), leaving the client UI hanging
// in agentRunning=true because no agent_end would ever arrive. These cases
// now also emit an `agent_error` SSE event so the client can reset state.
// ============================================================================

test("prompt failure emits agent_error to all listeners", async () => {
  const events: unknown[] = [];
  const inner = makeStubInner({
    prompt: () => Promise.reject(new Error("prompt boom")),
  });
  const w = new AgentSessionWrapper(inner);
  w.onEvent((e) => { events.push(e); });
  w.start();

  // prompt is fire-and-forget; send() returns before the rejection settles.
  await w.send({ type: "prompt", message: "hi" });
  await flushMicrotasks();

  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { type: "agent_error", errorMessage: "prompt boom" });
});

test("steer failure emits agent_error and rethrows", async () => {
  const events: unknown[] = [];
  const inner = makeStubInner({
    steer: () => Promise.reject(new Error("steer boom")),
  });
  const w = new AgentSessionWrapper(inner);
  w.onEvent((e) => { events.push(e); });
  w.start();

  await assert.rejects(w.send({ type: "steer", message: "hi" }), /steer boom/);

  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { type: "agent_error", errorMessage: "steer boom" });
});

test("follow_up dispatches immediately when the final settled event already passed", async () => {
  const events: Array<{ type?: string; items?: unknown[] }> = [];
  const prompts: string[] = [];
  const inner = makeStubInner({
    isStreaming: false,
    prompt: async (message) => {
      prompts.push(message);
    },
  });
  const w = new AgentSessionWrapper(inner);
  w.onEvent((event) => { events.push(event); });
  w.start();

  const snapshot = await w.send({ type: "follow_up", message: "hi" }) as {
    items: Array<{ message: string }>;
  };

  assert.deepEqual(prompts, ["hi"]);
  assert.deepEqual(snapshot.items, []);
  assert.equal(events.filter((event) => event.type === "follow_up_queue_update").length, 2);
  assert.deepEqual(events.at(-1)?.items, []);
  await w.destroy();
});

test("follow_up waits for the pending settled boundary after agent_end", async () => {
  let emitInner: ((event: unknown) => void) | null = null;
  const prompts: string[] = [];
  const inner = makeStubInner({
    isStreaming: true,
    sessionManager: {
      getBranch: () => [],
      getHeader: () => ({ cwd: "D:/project" }),
    },
    subscribe: (cb) => {
      emitInner = cb;
      return () => {};
    },
    prompt: async (message) => {
      prompts.push(message);
    },
  });
  const w = new AgentSessionWrapper(inner);
  w.start();
  const emit = (event: unknown) => {
    const listener = emitInner as ((value: unknown) => void) | null;
    assert.ok(listener);
    listener(event);
  };

  emit({ type: "agent_end", messages: [] });
  (inner as unknown as { isStreaming: boolean }).isStreaming = false;
  const queued = await w.send({ type: "follow_up", message: "after" }) as { items: unknown[] };
  assert.equal(queued.items.length, 1);
  assert.deepEqual(prompts, []);

  emit({ type: "agent_settled" });
  await flushMicrotasks();
  assert.deepEqual(prompts, ["after"]);
  await w.destroy();
});

test("agent_end without agent_settled is settled by the silence watchdog", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const originalSilence = AgentSessionWrapper.settleSilenceMs;
  AgentSessionWrapper.settleSilenceMs = 0;
  try {
    const events: Array<{ type?: string }> = [];
    const prompts: string[] = [];
    let emitInner: ((event: unknown) => void) | null = null;
    const inner = makeStubInner({
      isStreaming: true,
      sessionManager: {
        getBranch: () => [],
        getHeader: () => ({ cwd: "D:/project" }),
      },
      subscribe: (cb) => {
        emitInner = cb;
        return () => {};
      },
      prompt: async (message) => {
        prompts.push(message);
      },
    });
    const w = new AgentSessionWrapper(inner);
    w.onEvent((event) => { events.push(event as { type?: string }); });
    w.start();

    emitInner!({ type: "agent_end", messages: [] });
    assert.equal(
      events.some((event) => event.type === "agent_end"),
      false,
      "agent_end stays held until the settled boundary",
    );

    // 队列里排一条；settled 丢了就没人 drain，这条会永远卡住。
    const queued = await w.send({ type: "follow_up", message: "stuck" }) as { items: unknown[] };
    assert.equal(queued.items.length, 1);
    assert.deepEqual(prompts, []);

    (inner as unknown as { isStreaming: boolean }).isStreaming = false;
    mock.timers.tick(1000);
    await flushMicrotasks();

    assert.ok(
      events.some((event) => event.type === "agent_end"),
      "watchdog releases the held agent_end so the client stops spinning",
    );
    assert.deepEqual(prompts, ["stuck"]);
    await w.destroy();
  } finally {
    AgentSessionWrapper.settleSilenceMs = originalSilence;
    mock.timers.reset();
  }
});

test("queued follow-ups are reordered and dispatched one at each settled boundary", async () => {
  let emitInner: ((event: unknown) => void) | null = null;
  const prompts: string[] = [];
  const events: Array<{ type?: string }> = [];
  const inner = makeStubInner({
    isStreaming: true,
    sessionManager: {
      getBranch: () => [],
      getHeader: () => ({ cwd: "D:/project" }),
    },
    subscribe: (cb) => {
      emitInner = cb;
      return () => {};
    },
    prompt: async (message) => {
      prompts.push(message);
    },
  });
  const w = new AgentSessionWrapper(inner);
  w.onEvent((event) => events.push(event));
  w.start();
  const emit = (event: unknown) => {
    const listener = emitInner as ((value: unknown) => void) | null;
    assert.ok(listener);
    listener(event);
  };

  const first = await w.send({ type: "follow_up", message: "A" }) as {
    revision: number;
    items: Array<{ id: string }>;
  };
  const second = await w.send({ type: "follow_up", message: "B" }) as {
    revision: number;
    items: Array<{ id: string }>;
  };
  await w.send({
    type: "reorder_follow_ups",
    orderedIds: [second.items[1].id, first.items[0].id],
    expectedRevision: second.revision,
  });

  emit({ type: "agent_end", messages: [] });
  assert.equal(events.some((event) => event.type === "agent_end"), false);
  emit({ type: "agent_settled" });
  await flushMicrotasks();
  assert.deepEqual(prompts, ["B"]);

  emit({ type: "agent_end", messages: [] });
  emit({ type: "agent_settled" });
  await flushMicrotasks();
  assert.deepEqual(prompts, ["B", "A"]);

  emit({ type: "agent_end", messages: [] });
  emit({ type: "agent_settled" });
  await flushMicrotasks();
  // 每一轮都要把 agent_end 送到前端（包括队列非空的那几轮），
  // 否则 UI 会一直卡在 agentRunning，排队的消息看起来从没发出去。
  assert.equal(events.filter((event) => event.type === "agent_end").length, 3);
  await w.destroy();
});

test("agent_error reaches every listener even if an earlier listener throws", async () => {
  const events: unknown[] = [];
  const inner = makeStubInner({
    prompt: () => Promise.reject(new Error("boom")),
  });
  const w = new AgentSessionWrapper(inner);
  // First listener throws — must not prevent the second from receiving the event.
  w.onEvent(() => { throw new Error("listener broken"); });
  w.onEvent((e) => { events.push(e); });
  w.start();

  await w.send({ type: "prompt", message: "hi" });
  await flushMicrotasks();

  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { type: "agent_error", errorMessage: "boom" });
});

test("non-Error prompt rejection is stringified in agent_error", async () => {
  const events: unknown[] = [];
  const inner = makeStubInner({
    prompt: () => Promise.reject("string error"), // not an Error instance
  });
  const w = new AgentSessionWrapper(inner);
  w.onEvent((e) => { events.push(e); });
  w.start();

  await w.send({ type: "prompt", message: "hi" });
  await flushMicrotasks();

  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { type: "agent_error", errorMessage: "string error" });
});

test("agent event reaches every listener even if an earlier listener throws (M2)", async () => {
  const events: unknown[] = [];
  let capturedCb: ((event: unknown) => void) | undefined;
  const inner = makeStubInner({
    subscribe: (cb) => {
      capturedCb = cb as (event: unknown) => void;
      return () => {};
    },
  });
  const w = new AgentSessionWrapper(inner);
  // First listener throws — must not prevent the second from receiving the
  // event, and must not escape the subscribe callback into pi's loop.
  w.onEvent(() => {
    throw new Error("listener broken");
  });
  w.onEvent((e) => {
    events.push(e);
  });
  w.start();

  let thrown: unknown;
  try {
    capturedCb?.({ type: "custom_event" });
  } catch (err) {
    thrown = err;
  }

  assert.equal(thrown, undefined, "listener exception escaped the subscribe callback");
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { type: "custom_event" });
});

test("set_agent_mode plan forces read tools", async () => {
  const applied: string[][] = [];
  const w = new AgentSessionWrapper(makeStubInner({
    setActiveToolsByName: (names) => { applied.push([...names]); },
  }));
  w.initPolicy("ask", "default");
  const result = await w.send({ type: "set_agent_mode", mode: "plan" }) as { agentMode: string };
  assert.equal(result.agentMode, "plan");
  // Plan is read-only: the memory facade stays (recall only), writes are gated per action.
  assert.deepEqual(
    applied.at(-1)?.slice().sort(),
    ["find", "grep", "ls", "memory", "read", "tool_history_get"]
  );
});

test("get_state includes agentMode", async () => {
  const w = new AgentSessionWrapper(makeStubInner());
  w.initPolicy("full", "full");
  const state = await w.send({ type: "get_state" }) as { agentMode: string; toolPreset: string };
  assert.equal(state.agentMode, "full");
  assert.equal(state.toolPreset, "full");
});

test("extension_ui_response resolves bridge confirm", async () => {
  const { ExtensionUiBridge } = await import("./extension-ui-bridge.ts");
  const w = new AgentSessionWrapper(makeStubInner());
  const events: unknown[] = [];
  const bridge = new ExtensionUiBridge((e) => { events.push(e); });
  w.attachUiBridge(bridge);
  const p = bridge.confirm("t", "m");
  const req = events[0] as { id: string };
  await w.send({ type: "extension_ui_response", id: req.id, confirmed: true });
  assert.equal(await p, true);
});
test("setAgentMode appends custom entry to sessionManager", () => {
  const customEntries: Array<{ customType: string; data: unknown }> = [];
  const stubSessionManager = {
    appendCustomEntry: (customType: string, data: unknown) => {
      customEntries.push({ customType, data });
      return "entry-id-1";
    },
  };
  const w = new AgentSessionWrapper(makeStubInner({ sessionManager: stubSessionManager }));
  w.setAgentMode("plan");

  assert.equal(w.agentMode, "plan");
  assert.equal(customEntries.length, 1);
  assert.equal(customEntries[0].customType, "desktop_agent_mode");
  assert.deepEqual(customEntries[0].data, { mode: "plan" });
});

test("send set_agent_mode appends custom entry to sessionManager", async () => {
  const customEntries: Array<{ customType: string; data: unknown }> = [];
  const stubSessionManager = {
    appendCustomEntry: (customType: string, data: unknown) => {
      customEntries.push({ customType, data });
      return "entry-id-2";
    },
  };
  const w = new AgentSessionWrapper(makeStubInner({ sessionManager: stubSessionManager }));
  await w.send({ type: "set_agent_mode", mode: "ask" });

  assert.equal(w.agentMode, "ask");
  assert.equal(customEntries.length, 1);
  assert.equal(customEntries[0].customType, "desktop_agent_mode");
  assert.deepEqual(customEntries[0].data, { mode: "ask" });
});

test("startRpcSession restores historical agentMode from session entries when not explicitly specified", async () => {
  const { SessionManager } = await import("./sdk-adapter.ts");
  const { mkdtempSync, rmSync } = await import("fs");
  const { tmpdir } = await import("os");
  const { join } = await import("path");

  const dir = mkdtempSync(join(tmpdir(), "pi-rpc-mode-test-"));
  try {
    const sm = SessionManager.create(dir, dir);
    sm.appendMessage({ role: "user", content: "hello" } as never);
    sm.appendCustomEntry("desktop_agent_mode", { mode: "plan" });
    (sm as unknown as { _rewriteFile?: () => void })._rewriteFile?.();

    const file = sm.getSessionFile()!;
    const id = sm.getSessionId();

    const { session, realSessionId } = await startRpcSession(id, file, dir);
    assert.equal(realSessionId, id);
    assert.equal(session.agentMode, "plan");
    await session.destroy();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// Task P2: concurrency / robustness fixes in the RPC session layer
// ============================================================================

// --- P2-1: prompt/fork/compact must be rejected while the inner session is
// streaming. The UI pre-disables these controls, but the server guard is the
// deterministic backstop against double-fired prompts, mid-stream forks (which
// copy a half-written .jsonl and then destroy() aborts the running loop), and
// mid-stream compacts (which read an in-flux branch).

test("send prompt is rejected while streaming (P2-1)", async () => {
  const inner = makeStubInner({ isStreaming: true });
  const w = new AgentSessionWrapper(inner);
  w.start();
  await assert.rejects(w.send({ type: "prompt", message: "hi" }), /Session is streaming/);
});

test("send fork is rejected while streaming (P2-1)", async () => {
  const inner = makeStubInner({ isStreaming: true });
  const w = new AgentSessionWrapper(inner);
  w.start();
  await assert.rejects(w.send({ type: "fork", entryId: "x" }), /Session is streaming/);
});

test("send compact is rejected while streaming (P2-1)", async () => {
  const inner = makeStubInner({ isStreaming: true });
  const w = new AgentSessionWrapper(inner);
  w.start();
  await assert.rejects(w.send({ type: "compact" }), /Session is streaming/);
});

// --- P2-4: the onDestroy → registry.delete(realSessionId) callback must not
// evict a NEWER wrapper that was registered under the same id while the old
// wrapper's destroy() was still in flight (its onDestroy runs only after
// awaiting abort/unsubscribe).

test("destroy of a replaced wrapper does not unregister the new wrapper (P2-4)", async () => {
  const { SessionManager } = await import("./sdk-adapter.ts");
  const { mkdtempSync, rmSync } = await import("fs");
  const { tmpdir } = await import("os");
  const { join } = await import("path");

  const dir = mkdtempSync(join(tmpdir(), "pi-rpc-owner-test-"));
  let id: string | undefined;
  try {
    const sm = SessionManager.create(dir, dir);
    sm.appendMessage({ role: "user", content: "hello" } as never);
    (sm as unknown as { _rewriteFile?: () => void })._rewriteFile?.();
    const file = sm.getSessionFile()!;
    id = sm.getSessionId();

    // Start a real wrapper — this registers it under `id` and installs the real
    // onDestroy → registry.delete(id) callback from lib/rpc-manager.ts.
    const first = await startRpcSession(id, file, dir);
    const registry = getRpcSessionRegistry();
    assert.equal(registry.get(id), first.session);

    // Simulate the race: while the old wrapper is being destroyed, a NEW
    // wrapper is registered under the same id.
    const replacement = new AgentSessionWrapper(makeStubInner());
    registry.set(id, replacement);

    // Fire the old wrapper's onDestroy callbacks.
    await first.session.destroy();

    // The old wrapper's registry.delete(id) must NOT remove the replacement.
    assert.equal(registry.get(id), replacement);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    // Best-effort cleanup so later tests don't observe a half-dead registry.
    if (id) getRpcSessionRegistry().delete(id);
  }
});

// --- P2-5: destroy() must unsubscribe BEFORE aborting. abort() emits terminal
// events (agent_end, agent_error, …) as it tears down the loop; with the SSE
// listener still attached those would be delivered to a stream that is about
// to close (previously papered over by the M2 try/catch per listener).
// Unsubscribing first shrinks the delivery window to ~zero.

test("destroy() unsubscribes before aborting to stop event delivery (P2-5)", async () => {
  const order: string[] = [];
  const inner = makeStubInner({
    abort: async () => { order.push("abort"); },
    subscribe: () => {
      return () => { order.push("unsubscribe"); };
    },
  });
  const w = new AgentSessionWrapper(inner);
  w.start();
  await w.destroy();
  assert.deepEqual(order, ["unsubscribe", "abort"]);
});

