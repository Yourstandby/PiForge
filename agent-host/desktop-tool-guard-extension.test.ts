import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_TOOL_GUARD,
  TIMEOUT_HINT,
  TURN_BUDGET,
  TURN_BUDGET_EXHAUSTED_HINT,
  TURN_SELF_CHECK_HINT,
  createDesktopToolGuardFactory,
  createParallelTracker,
  createTurnBudgetTracker,
  emptyToolGuardStats,
  guardShellTimeout,
  isHeavyCommand,
  isTimeoutError,
  parallelAdvisory,
  resolveToolGuard,
  type ToolGuardConfig,
} from "./desktop-tool-guard-extension.ts";

const CONFIG: ToolGuardConfig = { ...DEFAULT_TOOL_GUARD };

test("a shell call without timeout gets a default instead of running forever", () => {
  const input: Record<string, unknown> = { command: "grep -rn foo ." };
  const outcome = guardShellTimeout(input, CONFIG);
  assert.deepEqual(outcome, { seconds: 120, action: "defaulted" });
  assert.equal(input.timeout, 120);
});

test("heavy commands get enough runway but still have a ceiling", () => {
  const input: Record<string, unknown> = { command: "npm run dist" };
  const outcome = guardShellTimeout(input, CONFIG);
  assert.deepEqual(outcome, { seconds: 900, action: "defaulted" });
  assert.equal(input.timeout, 900);

  const huge: Record<string, unknown> = { command: "npm run test", timeout: 100_000 };
  assert.deepEqual(guardShellTimeout(huge, CONFIG), { seconds: 900, action: "clamped" });
  assert.equal(huge.timeout, 900);
});

test("an explicit reasonable timeout is kept verbatim", () => {
  const input: Record<string, unknown> = { command: "node scripts/measure-prefix.mjs", timeout: 300 };
  assert.deepEqual(guardShellTimeout(input, CONFIG), { seconds: 300, action: "kept" });
  assert.equal(input.timeout, 300);
});

test("over-long timeouts are clamped, so one hang cannot hold a batch for minutes", () => {
  const input: Record<string, unknown> = { command: "grep -rn foo .", timeout: 5000 };
  assert.deepEqual(guardShellTimeout(input, CONFIG), { seconds: 600, action: "clamped" });
  assert.equal(input.timeout, 600);
});

test("invalid timeout values are repaired rather than making pi throw", () => {
  for (const raw of ["300", 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const input: Record<string, unknown> = { command: "ls", timeout: raw };
    const outcome = guardShellTimeout(input, CONFIG);
    assert.equal(outcome?.action, "repaired", `raw=${String(raw)}`);
    assert.equal(input.timeout, 120);
  }
});

test("heavy detection does not misfire on ordinary exploration", () => {
  assert.equal(isHeavyCommand("npm run test"), true);
  assert.equal(isHeavyCommand("node scripts/measure-prefix.mjs --turns 2"), true);
  assert.equal(isHeavyCommand("npx tsc --noEmit"), true);
  assert.equal(isHeavyCommand("grep -rn \"foo\" agent-host | head -20"), false);
  assert.equal(isHeavyCommand("git status --short"), false);
  assert.equal(isHeavyCommand("ls -la"), false);
});

test("the parallel advisory fires once per batch, then resets after the batch drains", () => {
  const tracker = createParallelTracker(8);
  const advisories: string[] = [];
  for (let i = 1; i <= 12; i += 1) {
    const advisory = tracker.begin(`call-${i}`, false);
    if (advisory) advisories.push(advisory);
  }
  assert.equal(advisories.length, 1, "only one advisory per batch, not one per excess call");
  assert.match(advisories[0]!, /并行 9 个调用/);
  assert.equal(tracker.peakParallel, 12);

  // 批次清空后重新计数。
  for (let i = 1; i <= 12; i += 1) tracker.end(`call-${i}`);
  assert.equal(tracker.size, 0);
  const again: string[] = [];
  for (let i = 1; i <= 10; i += 1) {
    const advisory = tracker.begin(`next-${i}`, false);
    if (advisory) again.push(advisory);
  }
  assert.equal(again.length, 1);
});

test("nested calls (a codemode script) never count toward the parallel budget", () => {
  const tracker = createParallelTracker(2);
  assert.equal(tracker.begin("outer", false), undefined);
  for (let i = 0; i < 10; i += 1) {
    assert.equal(tracker.begin(`outer/${i}`, true), undefined);
  }
  assert.equal(tracker.size, 1);
  assert.equal(tracker.peakParallel, 1);
});

test("timeout errors are recognised, ordinary errors are not", () => {
  assert.equal(isTimeoutError("timeout: 120"), true);
  assert.equal(isTimeoutError("Error: timeout:600\n"), true);
  assert.equal(isTimeoutError("exit code 1"), false);
  assert.equal(isTimeoutError("no such file"), false);
});

function hookInto(options?: { enabled?: () => boolean; env?: Record<string, string | undefined> }) {
  const handlers: Record<string, (event: unknown) => unknown> = {};
  const pi = {
    on: (name: string, cb: (event: unknown) => unknown) => {
      handlers[name] = cb;
      return () => {};
    },
  };
  createDesktopToolGuardFactory(options)(pi as never);
  return {
    start: () => handlers.before_agent_start?.({}),
    call: (event: unknown) => handlers.tool_call?.(event),
    result: (event: unknown) => handlers.tool_result?.(event),
  };
}

test("the extension patches timeout in place and leaves the input otherwise untouched", () => {
  const hooks = hookInto();
  const input: Record<string, unknown> = { command: "git status --short", timeout: undefined };
  hooks.call({ toolName: "bash", toolCallId: "c1", input });
  assert.equal(input.timeout, 120);

  const noTimeout: Record<string, unknown> = { command: "pwsh -c 'ls'" };
  hooks.call({ toolName: "powershell", toolCallId: "c2", input: noTimeout });
  assert.equal(noTimeout.timeout, 120);

  // 非 shell 工具不动任何参数。
  const readInput: Record<string, unknown> = { path: "a.ts" };
  hooks.call({ toolName: "read", toolCallId: "c3", input: readInput });
  assert.deepEqual(readInput, { path: "a.ts" });
});

test("a timeout result keeps its original text and only appends the fix-up hint", () => {
  const hooks = hookInto();
  hooks.call({ toolName: "bash", toolCallId: "c9", input: { command: "sleep 999" } });
  const out = hooks.result({
    toolName: "bash",
    toolCallId: "c9",
    input: { command: "sleep 999" },
    content: [{ type: "text", text: "timeout:120" }],
    isError: true,
  }) as { content: Array<{ text: string }> } | undefined;

  assert.ok(out, "timeout errors must get the hint");
  assert.equal(out.content.length, 2);
  assert.equal(out.content[0]!.text, "timeout:120");
  assert.equal(out.content[1]!.text, TIMEOUT_HINT);
});

test("successful results are not rewritten and non-timeout errors stay verbatim", () => {
  const hooks = hookInto();
  const ok = hooks.result({
    toolName: "bash",
    toolCallId: "c10",
    input: { command: "ls" },
    content: [{ type: "text", text: "a.ts b.ts" }],
    isError: false,
  });
  assert.equal(ok, undefined);

  const failed = hooks.result({
    toolName: "bash",
    toolCallId: "c11",
    input: { command: "ls nope" },
    content: [{ type: "text", text: "exit code 2" }],
    isError: true,
  });
  assert.equal(failed, undefined);
});

test("PIFORGE_TOOL_GUARD=0 disables every mutation", () => {
  const config = resolveToolGuard({ PIFORGE_TOOL_GUARD: "0" });
  assert.equal(config.enabled, false);

  const hooks = hookInto({ env: { PIFORGE_TOOL_GUARD: "0" } });
  const input: Record<string, unknown> = { command: "sleep 999" };
  hooks.call({ toolName: "bash", toolCallId: "c12", input });
  assert.equal(input.timeout, undefined, "disabled guard must not touch the call");
});

test("env overrides let the guard be tuned without touching code", () => {
  const config = resolveToolGuard({
    PIFORGE_TOOL_TIMEOUT_SECONDS: "30",
    PIFORGE_TOOL_TIMEOUT_MAX_SECONDS: "90",
    PIFORGE_TOOL_TIMEOUT_HEAVY_SECONDS: "45",
    PIFORGE_TOOL_MAX_PARALLEL: "3",
  });
  assert.deepEqual(config, {
    enabled: true,
    defaultSeconds: 30,
    maxSeconds: 90,
    heavySeconds: 45,
    maxParallel: 3,
  });
  const input: Record<string, unknown> = { command: "npm run test" };
  assert.deepEqual(guardShellTimeout(input, config), { seconds: 45, action: "defaulted" });
});

test("stats start empty and the advisory text names the actual numbers", () => {
  assert.deepEqual(emptyToolGuardStats(), {
    defaulted: 0,
    clamped: 0,
    repaired: 0,
    advisories: 0,
    timeoutHints: 0,
    peakParallel: 0,
    turnSelfChecks: 0,
    turnBudgetHits: 0,
  });
  assert.match(parallelAdvisory(25, 8), /并行 25 个调用（建议 ≤8）/);
  assert.match(parallelAdvisory(25, 8), /codemode/);
});

test("the turn budget self-checks at the 4th call and closes the line at the 8th", () => {
  const tracker = createTurnBudgetTracker();
  assert.equal(TURN_BUDGET.hardLimit, 8);
  const hints: (string | undefined)[] = [];
  for (let i = 0; i < 9; i += 1) hints.push(tracker.use(false));
  assert.equal(hints[3], TURN_SELF_CHECK_HINT);
  assert.equal(hints[7], TURN_BUDGET_EXHAUSTED_HINT);
  assert.equal(hints[8], TURN_BUDGET_EXHAUSTED_HINT, "超预算后每次都要提醒，而不是只提醒一次");
  assert.equal(hints[0] ?? hints[1] ?? hints[2], undefined);

  // 新用户轮重新计数。
  tracker.reset();
  assert.equal(tracker.used, 0);
  assert.equal(tracker.use(true), undefined, "codemode 嵌套调用不重复计数");
  assert.equal(tracker.used, 0);
});

test("the extension appends the self-check and exhaustion hints to tool results", () => {
  const hooks = hookInto();
  let hint: unknown;
  for (let i = 1; i <= 8; i += 1) {
    const id = `t${i}`;
    hooks.call({ toolName: "read", toolCallId: id, input: {} });
    hint = hooks.result({ toolCallId: id, content: [{ type: "text", text: "ok" }], isError: false });
  }
  const text = (hint as { content: { text: string }[] }).content.map((b) => b.text).join("\n");
  assert.match(text, /8 次调用预算已用完/);

  const second = hookInto();
  second.start();
  for (let i = 1; i <= 3; i += 1) {
    second.call({ toolName: "read", toolCallId: `s${i}`, input: {} });
    assert.equal(second.result({ toolCallId: `s${i}`, content: [], isError: false }), undefined);
  }
  second.call({ toolName: "read", toolCallId: "s4", input: {} });
  const fourth = second.result({ toolCallId: "s4", content: [], isError: false }) as {
    content: { text: string }[];
  };
  assert.match(fourth.content.map((b) => b.text).join("\n"), /中途自检/);
});
