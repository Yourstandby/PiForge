import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyTool,
  createDesktopToolSchedulerFactory,
  createLimiter,
  createScheduler,
  isExemptTool,
  queueAdvisory,
  resolveSchedulerConfig,
  type SchedulerConfig,
} from "./desktop-tool-scheduler-extension.ts";

const FAST: SchedulerConfig = {
  enabled: true,
  globalHeavy: 2,
  globalLight: 2,
  sessionHeavy: 1,
  sessionLight: 1,
  maxWaitMs: 40,
  queueHintMs: 0,
  maxHoldMs: 5_000,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("limiter grants exactly `limit` callers and queues the rest", async () => {
  const limiter = createLimiter(2);
  assert.equal(await limiter.acquire(0), true);
  assert.equal(await limiter.acquire(0), true);
  assert.equal(limiter.active, 2);

  let thirdGranted: boolean | null = null;
  const third = limiter.acquire(1_000).then((granted) => {
    thirdGranted = granted;
    return granted;
  });
  await sleep(10);
  assert.equal(thirdGranted, null, "third caller must wait while both slots are busy");
  assert.equal(limiter.waiting, 1);

  limiter.release();
  assert.equal(await third, true);
  assert.equal(limiter.active, 2);
});

test("a waiting caller gives up after maxWaitMs instead of hanging the tool call", async () => {
  const limiter = createLimiter(1);
  await limiter.acquire(0);
  assert.equal(await limiter.acquire(20), false);
  assert.equal(limiter.active, 1);
  assert.equal(limiter.waiting, 0);
});

test("heavy vs light classification follows the command, not the tool name", () => {
  assert.equal(classifyTool("bash", { command: "npm run dist" }), "heavy");
  assert.equal(classifyTool("bash", { command: "grep -rn foo ." }), "light");
  assert.equal(classifyTool("read", { path: "a.ts" }), "light");
  assert.equal(classifyTool("bash", {}), "light");
});

test("codemode and nested calls are exempt from the scheduler", () => {
  assert.equal(isExemptTool("codemode", false), true);
  assert.equal(isExemptTool("bash", true), true);
  assert.equal(isExemptTool("bash", false), false);
  assert.equal(isExemptTool("read", false), false);
});

test("one session cannot eat the global budget: its own quota is enforced", async () => {
  const scheduler = createScheduler({ ...FAST, maxWaitMs: 30 });
  const first = await scheduler.acquire({ callId: "a1", sessionKey: "s1", tier: "light" });
  assert.equal(first.granted, true);

  const second = await scheduler.acquire({ callId: "a2", sessionKey: "s1", tier: "light" });
  assert.equal(second.granted, false, "second call from the same session must not start");

  // 另一个会话仍然能拿到自己的配额。
  const other = await scheduler.acquire({ callId: "b1", sessionKey: "s2", tier: "light" });
  assert.equal(other.granted, true);

  scheduler.release("a1");
  scheduler.release("b1");
});

test("release frees the slot for the next session in line (FIFO)", async () => {
  const scheduler = createScheduler({ ...FAST, maxWaitMs: 500 });
  await scheduler.acquire({ callId: "h1", sessionKey: "s1", tier: "heavy" });
  await scheduler.acquire({ callId: "h2", sessionKey: "s2", tier: "heavy" });

  // 全局重型额度 = 2，第三个必须排队。
  let granted: boolean | null = null;
  const pending = scheduler
    .acquire({ callId: "h3", sessionKey: "s3", tier: "heavy" })
    .then((lease) => {
      granted = lease.granted;
      return lease;
    });
  await sleep(20);
  assert.equal(granted, null);

  scheduler.release("h1");
  const lease = await pending;
  assert.equal(lease.granted, true);
  assert.equal(granted, true);

  scheduler.release("h2");
  scheduler.release("h3");
});

test("releasing an unknown call is a no-op, and slots never go negative", () => {
  const scheduler = createScheduler(FAST);
  assert.equal(scheduler.release("never-acquired"), false);
  assert.equal(scheduler.stats().releases, 0);
});

test("a slot held past maxHoldMs is reclaimed instead of leaking forever", async () => {
  const scheduler = createScheduler({ ...FAST, maxHoldMs: 30, maxWaitMs: 20 });
  await scheduler.acquire({ callId: "stuck", sessionKey: "s1", tier: "light" });
  await sleep(60);
  assert.equal(scheduler.stats().leaked, 1);
  // 槽位已回收：同一会话的下一个调用能立刻开始。
  const next = await scheduler.acquire({ callId: "next", sessionKey: "s1", tier: "light" });
  assert.equal(next.granted, true);
  scheduler.release("next");
});

test("session shutdown releases everything the session still holds", async () => {
  const scheduler = createScheduler(FAST);
  await scheduler.acquire({ callId: "x1", sessionKey: "s1", tier: "light" });
  await scheduler.acquire({ callId: "x2", sessionKey: "s1", tier: "heavy" });
  scheduler.releaseSession("s1");
  assert.equal(scheduler.stats().releases, 0, "releaseSession 不走 release 计数");

  const after = await scheduler.acquire({ callId: "y1", sessionKey: "s2", tier: "light" });
  assert.equal(after.granted, true);
  scheduler.release("y1");
});

function hookInto(options?: {
  enabled?: () => boolean;
  sessionKey?: string;
  config?: SchedulerConfig;
  scheduler?: ReturnType<typeof createScheduler>;
}) {
  const handlers: Record<string, (event: unknown) => unknown> = {};
  const pi = {
    on: (name: string, cb: (event: unknown) => unknown) => {
      handlers[name] = cb;
      return () => {};
    },
  };
  const scheduler = options?.scheduler ?? createScheduler({ ...FAST, maxWaitMs: 500 });
  createDesktopToolSchedulerFactory({
    getSessionKey: () => options?.sessionKey ?? "s1",
    enabled: options?.enabled,
    config: options?.config ?? FAST,
    scheduler,
  })(pi as never);
  return {
    scheduler,
    call: (event: unknown) => handlers.tool_call?.(event) as Promise<unknown>,
    result: (event: unknown) => handlers.tool_result?.(event),
    shutdown: () => handlers.session_shutdown?.({}),
  };
}

test("the extension queues a call in tool_call and releases it on tool_result", async () => {
  const hooks = hookInto();
  await hooks.call({ toolName: "bash", toolCallId: "c1", input: { command: "grep -rn a ." } });

  // 配额 = 1：第二个调用必须等到第一个 release 才返回。
  let done = false;
  const second = hooks
    .call({ toolName: "bash", toolCallId: "c2", input: { command: "grep -rn b ." } })
    .then(() => {
      done = true;
    });
  await sleep(20);
  assert.equal(done, false, "second call must be parked inside tool_call");

  hooks.result({ toolName: "bash", toolCallId: "c1", input: {}, content: [], isError: false });
  await second;
  assert.equal(done, true);
});

test("exempt tools (codemode / nested) never touch the scheduler", async () => {
  const hooks = hookInto();
  await hooks.call({ toolName: "codemode", toolCallId: "k1", input: {} });
  await hooks.call({ toolName: "bash", toolCallId: "k2", input: { command: "ls" }, parentToolCallId: "k1" });
  assert.equal(hooks.scheduler.stats().acquired, 0);
});

test("a queued call gets one hint appended, and the result body is untouched", async () => {
  const hooks = hookInto({ config: { ...FAST, queueHintMs: 0, maxWaitMs: 5_000 } });
  await hooks.call({ toolName: "bash", toolCallId: "q1", input: { command: "ls" } });

  let queued: Promise<unknown>;
  const ready = new Promise<void>((resolve) => {
    queued = hooks.call({ toolName: "bash", toolCallId: "q2", input: { command: "ls" } });
    setTimeout(resolve, 30);
  });
  await ready;
  hooks.result({ toolName: "bash", toolCallId: "q1", input: {}, content: [], isError: false });
  await queued!;

  const out = hooks.result({
    toolName: "bash",
    toolCallId: "q2",
    input: {},
    content: [{ type: "text", text: "a.ts" }],
    isError: false,
  }) as { content: Array<{ text: string }> } | undefined;

  assert.ok(out, "queued call must carry the hint");
  assert.equal(out.content[0]!.text, "a.ts");
  assert.match(out.content[1]!.text, /等了 .*s 才拿到执行槽位/);
});

test("PIFORGE_TOOL_SCHEDULER=0 disables the whole thing", async () => {
  const config = resolveSchedulerConfig({ PIFORGE_TOOL_SCHEDULER: "0" });
  assert.equal(config.enabled, false);

  const hooks = hookInto({ enabled: () => false });
  await hooks.call({ toolName: "bash", toolCallId: "d1", input: { command: "ls" } });
  await hooks.call({ toolName: "bash", toolCallId: "d2", input: { command: "ls" } });
  assert.equal(hooks.scheduler.stats().acquired, 0);
});

test("env knobs override every limit", () => {
  const config = resolveSchedulerConfig({
    PIFORGE_SCHED_GLOBAL_HEAVY: "1",
    PIFORGE_SCHED_GLOBAL_LIGHT: "3",
    PIFORGE_SCHED_SESSION_HEAVY: "2",
    PIFORGE_SCHED_SESSION_LIGHT: "4",
    PIFORGE_SCHED_MAX_WAIT_MS: "500",
    PIFORGE_SCHED_MAX_HOLD_MS: "9000",
  });
  assert.equal(config.globalHeavy, 1);
  assert.equal(config.globalLight, 3);
  assert.equal(config.sessionHeavy, 2);
  assert.equal(config.sessionLight, 4);
  assert.equal(config.maxWaitMs, 500);
  assert.equal(config.maxHoldMs, 9000);
});

test("the advisory names the tier and tells the model what to do instead", () => {
  assert.match(queueAdvisory(2100, "heavy"), /等了 2\.1s/);
  assert.match(queueAdvisory(2100, "heavy"), /codemode/);
});
