import test from "node:test";
import assert from "node:assert/strict";
import { ProgressTracker, describeSuspectedBlocker } from "./progress-tracker.ts";
import {
  getTaskStatus,
  getWatchdogSnapshot,
  performIntervention,
  isWatchdogEnabled,
  observeAgentEvent,
  registerWatchSession,
  resetWatchdogForTest,
  resolveWatchdogConfig,
  runWatchdogTick,
  setWatchdogClockForTest,
  setWatchdogStallMs,
  watchdogTimerActiveForTest,
} from "./watchdog.ts";

const SESSION = "session-a";

function fixedClock(start = 1_000_000) {
  let now = start;
  const advance = (ms: number) => {
    now += ms;
    return now;
  };
  return { now: () => now, advance };
}

function toolOk(toolCallId: string, toolName: string, args: unknown, text = "ok") {
  return {
    type: "tool_execution_end",
    toolCallId,
    toolName,
    args,
    isError: false,
    result: { content: [{ type: "text", text }] },
    durationMs: 12,
  };
}

function toolFail(toolCallId: string, toolName: string, args: unknown, error: string) {
  return {
    type: "tool_execution_end",
    toolCallId,
    toolName,
    args,
    isError: true,
    result: { content: [{ type: "text", text: error }] },
  };
}

// ---------------------------------------------------------------------------
// A. ProgressTracker：只有「有效进展」刷 lastActivityAt
// ---------------------------------------------------------------------------

test("successful tool call is progress, failure and duplicate are not", () => {
  const clock = fixedClock();
  const tracker = new ProgressTracker(clock.now);
  tracker.beginTask(SESSION, "/repo");

  // 成功调用 → 有效活动
  clock.advance(1_000);
  tracker.observe(SESSION, toolOk("1", "read", { path: "a.ts" }));
  let task = tracker.taskOf(SESSION)!;
  assert.equal(task.completedSteps, 1);
  assert.equal(task.lastActivityAt, clock.now());
  assert.equal(task.lastSuccessAction, "read");

  // 失败调用 → 只记尝试时间
  clock.advance(5_000);
  tracker.observe(SESSION, toolFail("2", "bash", { command: "npm test" }, "ENOENT"));
  task = tracker.taskOf(SESSION)!;
  assert.equal(task.lastActivityAt, 1_001_000, "失败不刷有效活动时间");
  assert.equal(task.lastAttemptAt, clock.now());
  assert.equal(task.failedAttempts, 1);
  assert.equal(task.completedSteps, 1);

  // 同一个成功调用重复 → 也不刷
  clock.advance(5_000);
  tracker.observe(SESSION, toolOk("3", "read", { path: "a.ts" }));
  task = tracker.taskOf(SESSION)!;
  assert.equal(task.lastActivityAt, 1_001_000, "重复调用不算进展");
  assert.equal(task.duplicateAttempts, 1);
  assert.equal(task.completedSteps, 1);

  // 新的成功调用 → 恢复进展
  clock.advance(5_000);
  tracker.observe(SESSION, toolOk("4", "edit", { path: "a.ts" }));
  task = tracker.taskOf(SESSION)!;
  assert.equal(task.lastActivityAt, clock.now());
  assert.equal(task.completedSteps, 2);
});

test("empty tool result is neither progress nor success", () => {
  const clock = fixedClock();
  const tracker = new ProgressTracker(clock.now);
  tracker.beginTask(SESSION);
  const before = tracker.taskOf(SESSION)!.lastActivityAt;
  clock.advance(2_000);
  tracker.observe(SESSION, {
    type: "tool_execution_end",
    toolCallId: "1",
    toolName: "ls",
    args: { path: "." },
    isError: false,
    result: { content: [{ type: "text", text: "   " }] },
  });
  const task = tracker.taskOf(SESSION)!;
  assert.equal(task.lastActivityAt, before);
  assert.equal(task.completedSteps, 0);
  assert.equal(task.duplicateAttempts, 1);
});

test("growing assistant text counts as progress, repeated same text does not", () => {
  const clock = fixedClock();
  const tracker = new ProgressTracker(clock.now);
  tracker.beginTask(SESSION);
  const base = tracker.taskOf(SESSION)!.lastActivityAt;

  clock.advance(3_000);
  tracker.observe(SESSION, {
    type: "message_update",
    message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
  });
  assert.equal(tracker.taskOf(SESSION)!.lastActivityAt, clock.now());
  assert.ok(tracker.taskOf(SESSION)!.lastActivityAt > base);

  clock.advance(3_000);
  tracker.observe(SESSION, {
    type: "message_update",
    message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
  });
  assert.equal(
    tracker.taskOf(SESSION)!.lastActivityAt,
    base + 3_000,
    "同样的正文长度不算增量",
  );

  clock.advance(1_000);
  tracker.observe(SESSION, {
    type: "message_update",
    message: { role: "assistant", content: [{ type: "text", text: "hello world" }] },
  });
  assert.equal(tracker.taskOf(SESSION)!.lastActivityAt, clock.now());
});

test("suspected blocker names the pending tool and the failing tool", () => {
  const clock = fixedClock();
  const tracker = new ProgressTracker(clock.now);
  tracker.beginTask(SESSION);
  tracker.observe(SESSION, {
    type: "tool_execution_start",
    toolCallId: "1",
    toolName: "bash",
    args: { command: "npm run dev" },
  });
  let task = tracker.taskOf(SESSION)!;
  clock.advance(95_000);
  assert.match(describeSuspectedBlocker(task, clock.now()), /bash 已执行 95s/);

  tracker.observe(SESSION, toolFail("1", "bash", { command: "npm run dev" }, "exit 1"));
  tracker.observe(SESSION, {
    type: "tool_execution_start",
    toolCallId: "2",
    toolName: "bash",
    args: { command: "npm run dev" },
  });
  tracker.observe(SESSION, toolFail("2", "bash", { command: "npm run dev" }, "exit 1"));
  task = tracker.taskOf(SESSION)!;
  assert.match(describeSuspectedBlocker(task, clock.now()), /bash 连续失败 2 次/);
});

// ---------------------------------------------------------------------------
// B. Watchdog：升级 / 退避 / 失败 / 恢复
// ---------------------------------------------------------------------------

test("switch off: no timer, empty snapshot, no tracking", () => {
  resetWatchdogForTest({ enabled: false });
  setWatchdogClockForTest(fixedClock().now);
  observeAgentEvent(SESSION, { type: "agent_start" });
  assert.equal(isWatchdogEnabled(), false);
  assert.equal(watchdogTimerActiveForTest(), false, "关闭时不得建定时器");
  const snapshot = getWatchdogSnapshot();
  assert.deepEqual(snapshot, { enabled: false, config: null, tasks: [], notices: [] });
  assert.equal(getTaskStatus("anything"), null);
});

test("three consecutive stale scans escalate to stalled and emit a notice", () => {
  const clock = fixedClock();
  resetWatchdogForTest({ tickMs: 10_000, stallMs: 90_000, stallScans: 3, backoffMs: [30_000, 60_000, 120_000] });
  setWatchdogClockForTest(clock.now);
  observeAgentEvent(SESSION, { type: "agent_start" });

  // 90s 内不判卡顿
  clock.advance(80_000);
  assert.equal(runWatchdogTick(clock.now()).length, 0);
  assert.equal(getWatchdogSnapshot().tasks[0].status, "running");

  clock.advance(20_000); // 100s 无进展 → 第 1 次扫描
  assert.equal(runWatchdogTick(clock.now()).length, 0);
  clock.advance(10_000); // 第 2 次
  assert.equal(runWatchdogTick(clock.now()).length, 0);
  clock.advance(10_000); // 第 3 次 → stalled
  const notices = runWatchdogTick(clock.now());
  assert.equal(notices.length, 1);
  assert.equal(notices[0].type, "stalled");
  assert.equal(notices[0].level, "low");
  assert.equal(notices[0].task_id, getWatchdogSnapshot().tasks[0].taskId);
  assert.equal(notices[0].session_id, SESSION);
  assert.ok(notices[0].idle_seconds >= 90);
  assert.equal(notices[0].last_success_action, null);
  assert.ok(notices[0].suspected_blocker.length > 0);

  const snapshot = getWatchdogSnapshot(clock.now());
  assert.equal(snapshot.tasks[0].status, "stalled");
  assert.equal(snapshot.notices.length, 1);
});

test("backoff repeats 3 times then marks failed", () => {
  const clock = fixedClock();
  resetWatchdogForTest({ stallMs: 90_000, stallScans: 1, backoffMs: [30_000, 60_000, 120_000] });
  setWatchdogClockForTest(clock.now);
  observeAgentEvent(SESSION, { type: "agent_start" });

  clock.advance(100_000);
  runWatchdogTick(clock.now()); // stalled + 首次通知

  const repeats: number[] = [];
  for (const delay of [30_000, 60_000, 120_000]) {
    clock.advance(delay);
    for (const notice of runWatchdogTick(clock.now())) {
      repeats.push(notice.repeat);
      assert.equal(notice.type, "stalled");
    }
  }
  assert.deepEqual(repeats, [1, 2, 3]);

  clock.advance(120_000);
  const failing = runWatchdogTick(clock.now());
  assert.equal(failing.length, 1);
  assert.equal(failing[0].type, "failed");
  assert.equal(getWatchdogSnapshot().tasks[0].status, "failed");

  // failed 之后不再重复通知
  clock.advance(10 * 60_000);
  assert.equal(runWatchdogTick(clock.now()).length, 0);
});

test("progress after a stall recovers the task and emits a recovered notice", () => {
  const clock = fixedClock();
  resetWatchdogForTest({ stallMs: 90_000, stallScans: 1, backoffMs: [30_000, 60_000, 120_000] });
  setWatchdogClockForTest(clock.now);
  observeAgentEvent(SESSION, { type: "agent_start" });
  clock.advance(100_000);
  runWatchdogTick(clock.now());
  assert.equal(getWatchdogSnapshot().tasks[0].status, "stalled");

  clock.advance(5_000);
  observeAgentEvent(SESSION, toolOk("9", "bash", { command: "echo hi" }));
  const snapshot = getWatchdogSnapshot(clock.now());
  assert.equal(snapshot.tasks[0].status, "running");
  const last = snapshot.notices[snapshot.notices.length - 1];
  assert.equal(last.type, "recovered");
  assert.equal(snapshot.tasks[0].completedSteps, 1);
});

test("task completes on agent_end and stops being scanned", () => {
  const clock = fixedClock();
  resetWatchdogForTest({ stallMs: 90_000, stallScans: 1 });
  setWatchdogClockForTest(clock.now);
  observeAgentEvent(SESSION, { type: "agent_start" });
  observeAgentEvent(SESSION, { type: "agent_end", messages: [] });
  clock.advance(10 * 60_000);
  assert.equal(runWatchdogTick(clock.now()).length, 0);
  assert.equal(getWatchdogSnapshot().tasks[0].status, "completed");
});

test("config resolves env flags, defaulting to enabled", () => {
  assert.equal(resolveWatchdogConfig({}).enabled, true);
  assert.equal(resolveWatchdogConfig({}).stallMs, 20_000);
  assert.equal(resolveWatchdogConfig({}).tickMs, 10_000);
  assert.equal(resolveWatchdogConfig({ PIFORGE_WATCHDOG: "0" }).enabled, false);
  assert.equal(resolveWatchdogConfig({ PIFORGE_WATCHDOG: "off" }).enabled, false);
  assert.equal(resolveWatchdogConfig({ PIFORGE_WATCHDOG: "on" }).enabled, true);
  assert.equal(resolveWatchdogConfig({ PIFORGE_WATCHDOG_STALL_MS: "5000" }).stallMs, 5_000);
  assert.equal(resolveWatchdogConfig({ PIFORGE_WATCHDOG_STALL_MS: "abc" }).stallMs, 20_000);
});

test("watchdog.configure switches the threshold at runtime and clamps the range", () => {
  const clock = fixedClock();
  resetWatchdogForTest({ stallMs: 90_000, stallScans: 1, backoffMs: [30_000] });
  setWatchdogClockForTest(clock.now);
  observeAgentEvent(SESSION, { type: "agent_start" });

  clock.advance(30_000);
  assert.equal(runWatchdogTick(clock.now()).length, 0, "90s 阈值下 30s 不算卡顿");

  // 阈值下调到 15s → 下一个 tick 立即判 stalled（staleScans 已清零）。
  assert.equal(setWatchdogStallMs(15_000).stallMs, 15_000);
  assert.equal(getWatchdogSnapshot().config?.stallMs, 15_000);
  const notices = runWatchdogTick(clock.now());
  assert.equal(notices.length, 1);
  assert.equal(notices[0].type, "stalled");

  // 越界钳制：太低 → 5s，太高 → 10min；非数字直接抛错。
  assert.equal(setWatchdogStallMs(1).stallMs, 5_000);
  assert.equal(setWatchdogStallMs(999_999).stallMs, 600_000);
  assert.throws(() => setWatchdogStallMs(Number.NaN), RangeError);
});

test("registering a session starts the timer and the notice queue is bounded", () => {
  resetWatchdogForTest({ noticeLimit: 3 });
  setWatchdogClockForTest(fixedClock().now);
  registerWatchSession("session-b", "/repo");
  assert.equal(watchdogTimerActiveForTest(), true);
  observeAgentEvent("session-b", { type: "agent_start" });
  for (let index = 0; index < 5; index += 1) observeAgentEvent("session-b", { type: "agent_start" });
  assert.ok(getWatchdogSnapshot().notices.length <= 3);
});

// ---------------------------------------------------------------------------
// C. 人工介入（HITL）：stalled → Skip → 队列收到指令 + 状态回 running
// ---------------------------------------------------------------------------

function fakeSession() {
  const delivered: string[] = [];
  return {
    delivered,
    async deliverIntervention(message: string) {
      delivered.push(message);
      return { delivered: "steer" as const };
    },
  };
}

test("intervening on a stalled task injects the skip instruction and resets to running", async () => {
  const clock = fixedClock();
  resetWatchdogForTest({ stallMs: 90_000, stallScans: 1, backoffMs: [30_000, 60_000, 120_000] });
  setWatchdogClockForTest(clock.now);
  observeAgentEvent(SESSION, { type: "agent_start" });
  clock.advance(100_000);
  runWatchdogTick(clock.now());
  assert.equal(getWatchdogSnapshot().tasks[0].status, "stalled");

  const session = fakeSession();
  clock.advance(1_000);
  const outcome = await performIntervention({ sessionId: SESSION, actionType: "skip", session, now: clock.now() });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.delivered, "steer");
  assert.equal(outcome.actionType, "skip");
  // 「队列收到了提示词」：原文一字不差
  assert.deepEqual(session.delivered, [
    "[系统提示] 当前工具执行因无进展被系统强制跳过。请反思刚才为什么卡住，并立刻尝试其他替代方案继续完成任务。",
  ]);
  // 状态被重置：红灯 → 绿灯，计数清零
  assert.equal(outcome.task?.status, "running");
  assert.equal(outcome.task?.interventionCount, 1);
  const snapshot = getWatchdogSnapshot();
  assert.equal(snapshot.tasks[0].status, "running");
  assert.equal(snapshot.tasks[0].idleSeconds, 0);
  const last = snapshot.notices[snapshot.notices.length - 1];
  assert.equal(last.type, "recovered");
  assert.match(last.message, /人工介入（强制跳过）/);
  // 重置后 90s 内不会被再次判 stalled
  clock.advance(80_000);
  assert.equal(runWatchdogTick(clock.now()).length, 0);
  assert.equal(getWatchdogSnapshot().tasks[0].status, "running");
});

test("ask uses the last successful action in the injected message", async () => {
  const clock = fixedClock();
  resetWatchdogForTest({ stallMs: 90_000, stallScans: 1 });
  setWatchdogClockForTest(clock.now);
  observeAgentEvent(SESSION, { type: "agent_start" });
  observeAgentEvent(SESSION, toolOk("1", "bash", { command: "npm test" }));
  clock.advance(100_000);
  runWatchdogTick(clock.now());

  const session = fakeSession();
  const outcome = await performIntervention({ sessionId: SESSION, actionType: "ask", session, now: clock.now() });
  assert.equal(outcome.ok, true);
  assert.match(session.delivered[0], /你之前在 bash 之后似乎卡住了/);
  assert.equal(getWatchdogSnapshot().tasks[0].status, "running");
});

test("brief ask injects the minimal no-tool prompt and resets to running", async () => {
  const clock = fixedClock();
  resetWatchdogForTest({ stallMs: 90_000, stallScans: 1 });
  setWatchdogClockForTest(clock.now);
  observeAgentEvent(SESSION, { type: "agent_start" });
  observeAgentEvent(SESSION, toolOk("1", "bash", { command: "npm test" }));
  clock.advance(100_000);
  runWatchdogTick(clock.now());

  const session = fakeSession();
  const outcome = await performIntervention({
    sessionId: SESSION,
    actionType: "ask_brief",
    session,
    now: clock.now(),
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.actionType, "ask_brief");
  // 队列里收到的就是精简后的那一句：不含 lastSuccessAction 拼接，也不含「给出新的执行方案」。
  assert.deepEqual(session.delivered, [
    "[系统提示] 看门狗发现当前工具已超时无输出，请勿执行任何新工具核实。请直接用一句话（20字以内）告诉我：你卡在哪个工具了，是否需要我帮你跳过？",
  ]);
  assert.equal(outcome.message.includes("新的执行方案"), false);
  assert.equal(outcome.message.includes("分析原因"), false);
  assert.equal(outcome.task?.status, "running");
  // 审计文案能区分极简询问与深度诊断（排查 Token 花在哪）。
  const snapshot = getWatchdogSnapshot();
  const last = snapshot.notices[snapshot.notices.length - 1];
  assert.match(last.message, /极简询问/);
});

test("duplicate clicks are rejected host-side and never reach the queue twice", async () => {
  const clock = fixedClock();
  resetWatchdogForTest({ stallMs: 90_000, stallScans: 1 });
  setWatchdogClockForTest(clock.now);
  observeAgentEvent(SESSION, { type: "agent_start" });
  clock.advance(100_000);
  runWatchdogTick(clock.now());

  const session = fakeSession();
  const first = await performIntervention({ sessionId: SESSION, actionType: "skip", session, now: clock.now() });
  assert.equal(first.ok, true);
  // 立刻再点一次（仍在冷却内）：状态已被重置为 running，但看门狗仍在计时窗口里，
  // 这里断言的是「同动作冷却」这条守卫生效。
  const second = await performIntervention({
    sessionId: SESSION,
    actionType: "skip",
    session,
    now: clock.now() + 200,
  });
  assert.equal(second.ok, false);
  assert.equal(second.rejected, "duplicate");
  assert.equal(session.delivered.length, 1, "重复点击不得再注入一条");
});

test("intervention is refused when nothing is running or the watchdog is off", async () => {
  const clock = fixedClock();
  resetWatchdogForTest({ stallMs: 90_000, stallScans: 1 });
  setWatchdogClockForTest(clock.now);
  const session = fakeSession();

  const noTask = await performIntervention({ sessionId: SESSION, actionType: "skip", session, now: clock.now() });
  assert.equal(noTask.ok, false);
  assert.equal(noTask.rejected, "no_active_task");
  assert.equal(session.delivered.length, 0);

  observeAgentEvent(SESSION, { type: "agent_end", messages: [] });
  const finished = await performIntervention({ sessionId: SESSION, actionType: "ask", session, now: clock.now() });
  assert.equal(finished.ok, false);
  assert.equal(finished.rejected, "no_active_task");

  resetWatchdogForTest({ enabled: false });
  setWatchdogClockForTest(fixedClock().now);
  const disabled = await performIntervention({ sessionId: SESSION, actionType: "skip", session });
  assert.equal(disabled.ok, false);
  assert.equal(session.delivered.length, 0);
});

test("the intervention cap stops a click storm", async () => {
  const clock = fixedClock();
  resetWatchdogForTest({ stallMs: 90_000, stallScans: 1 });
  setWatchdogClockForTest(clock.now);
  observeAgentEvent(SESSION, { type: "agent_start" });
  clock.advance(100_000);
  runWatchdogTick(clock.now());

  const session = fakeSession();
  let allowed = 0;
  for (let index = 0; index < 8; index += 1) {
    const outcome = await performIntervention({
      sessionId: SESSION,
      actionType: "skip",
      session,
      now: clock.now() + index * 5_000,
    });
    if (outcome.ok) allowed += 1;
  }
  assert.equal(allowed, 5, "每个任务最多 5 次介入");
  assert.equal(session.delivered.length, 5);
});

// ---------------------------------------------------------------------------
// D. 并发长任务：6 个工具同时在跑，必须被登记、必须能判 stalled
// ---------------------------------------------------------------------------

function startTool(toolCallId: string, toolName = "bash") {
  return {
    type: "tool_execution_start",
    toolCallId,
    toolName,
    args: { command: `npm run job-${toolCallId}` },
  };
}

function startSixTools() {
  observeAgentEvent(SESSION, { type: "agent_start" });
  for (let index = 1; index <= 6; index += 1) {
    observeAgentEvent(SESSION, startTool(`call-${index}`));
  }
}

test("six concurrent tools with no output still produce a tracked task", () => {
  const clock = fixedClock();
  resetWatchdogForTest({ stallMs: 90_000, stallScans: 3 });
  setWatchdogClockForTest(clock.now);
  startSixTools();
  clock.advance(62_000);

  // 回归点：以前并发场景下面板会显示「本会话暂无任务」。
  const snapshot = getWatchdogSnapshot(clock.now());
  assert.equal(snapshot.tasks.length, 1, "并发工具必须能被面板看到");
  const view = snapshot.tasks[0]!;
  assert.equal(view.status, "running");
  assert.equal(view.activeToolCount, 6, "6 个并发工具各自一条");
  assert.equal(view.tools.length, 6);
  assert.equal(view.idleSeconds, 62, "62 秒无进展要如实显示");
  assert.equal(view.toolIdleSeconds, 62);
  assert.ok(view.lastLivenessAt >= view.startedAt, "工具启动会刷心跳");
  assert.match(view.suspectedBlocker, /6 个工具并发执行中/);

  // last_activity_ts 不会被「没有新输出」偷偷重置（62s 内没有 tick）。
  runWatchdogTick(clock.now());
  const after = getWatchdogSnapshot(clock.now()).tasks[0]!;
  assert.equal(after.lastActivityAt, view.lastActivityAt);
  assert.equal(after.idleSeconds, 62);
});

test("one blocked tool escalates to stalled on the very first scan", () => {
  const clock = fixedClock();
  resetWatchdogForTest({ stallMs: 20_000, stallScans: 3, backoffMs: [30_000, 60_000, 120_000] });
  setWatchdogClockForTest(clock.now);
  startSixTools();

  clock.advance(10_000);
  assert.equal(runWatchdogTick(clock.now()).length, 0, "还没到阈值");
  assert.equal(getWatchdogSnapshot(clock.now()).tasks[0]?.status, "running");

  clock.advance(11_000); // 21s > 20s 阈值
  const notices = runWatchdogTick(clock.now());
  assert.equal(notices.length, 1, "任一工具超阈 → 第一次扫描就报警");
  assert.equal(notices[0]!.type, "stalled");
  assert.equal(notices[0]!.idle_seconds, 21);
  assert.match(notices[0]!.suspected_blocker, /6 个工具并发执行中/);

  const view = getWatchdogSnapshot(clock.now()).tasks[0]!;
  assert.equal(view.status, "stalled");
  assert.equal(view.activeToolCount, 6);
  assert.equal(view.tools.every((tool) => tool.overThreshold), true, "6 个都超阈，UI 逐个标红");
});

test("finishing one of the concurrent tools keeps tracking the rest", () => {
  const clock = fixedClock();
  resetWatchdogForTest({ stallMs: 90_000, stallScans: 3 });
  setWatchdogClockForTest(clock.now);
  startSixTools();
  clock.advance(5_000);
  observeAgentEvent(SESSION, toolOk("call-3", "bash", { command: "npm run job-3" }, "done"));
  clock.advance(3_000);

  const view = getWatchdogSnapshot(clock.now()).tasks[0]!;
  assert.equal(view.activeToolCount, 5);
  assert.equal(view.tools.some((tool) => tool.toolCallId === "call-3"), false);
  assert.equal(view.completedSteps, 1);
  assert.equal(view.status, "running");
});

test("one tool streaming output does not hide the other blocked tools", () => {
  const clock = fixedClock();
  resetWatchdogForTest({ stallMs: 20_000, stallScans: 3 });
  setWatchdogClockForTest(clock.now);
  startSixTools();
  clock.advance(25_000);
  // call-1 有输出：它的 idle 归零，但另外 5 个已经 25s 没输出。
  observeAgentEvent(SESSION, {
    type: "tool_execution_update",
    toolCallId: "call-1",
    toolName: "bash",
    args: {},
    partialResult: { content: [{ type: "text", text: "still working" }] },
  });
  const view = getWatchdogSnapshot(clock.now()).tasks[0]!;
  assert.equal(view.activeToolCount, 6);
  assert.equal(
    view.tools.find((tool) => tool.toolCallId === "call-1")?.idleSeconds,
    0,
    "刚输出过的工具 idle 归零",
  );
  assert.equal(view.toolIdleSeconds, 25, "聚合计时取最久的那个（不会被单个工具的输出掩盖）");
  assert.equal(view.idleSeconds, 25);
  // 心跳看 liveness：刚刚有过输出/启动，心跳是新的。
  assert.equal(view.lastLivenessAt, clock.now());

  // 下一次扫描：剩下 5 个工具都超阈 → 依然立刻报警。
  const emitted = runWatchdogTick(clock.now());
  assert.equal(emitted.length, 1, "其余 5 个工具超阈仍然要报");
  const blocked = getWatchdogSnapshot(clock.now()).tasks[0]!;
  assert.equal(blocked.status, "stalled");
  assert.equal(blocked.tools.find((tool) => tool.toolCallId === "call-1")?.overThreshold, false);
  assert.equal(blocked.tools.filter((tool) => tool.overThreshold).length, 5);
});
