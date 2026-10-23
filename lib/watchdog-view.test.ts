import test from "node:test";
import assert from "node:assert/strict";
import type { StatusNotice, WatchdogTaskView } from "../contract/domains/watchdog.ts";
import {
  describeStall,
  formatIdleSeconds,
  latestNoticeForSession,
  livenessSeconds,
  panelLight,
  pickSessionTask,
  sessionStatusDot,
  toolSummary,
} from "./watchdog-view.ts";

function task(overrides: Partial<WatchdogTaskView> = {}): WatchdogTaskView {
  return {
    taskId: "s~1",
    sessionId: "s",
    status: "running",
    startedAt: 1_000,
    lastActivityAt: 10_000,
    lastAttemptAt: 10_000,
    lastLivenessAt: 10_000,
    idleSeconds: 0,
    activeToolCount: 0,
    toolIdleSeconds: 0,
    tools: [],
    completedSteps: 3,
    attempts: 5,
    failedAttempts: 1,
    duplicateAttempts: 1,
    lastSuccessAction: "read",
    lastError: null,
    suspectedBlocker: "最近无新事件",
    pendingTool: null,
    noticeCount: 0,
    interventionCount: 0,
    lastInterventionAt: null,
    ...overrides,
  };
}

function notice(overrides: Partial<StatusNotice> = {}): StatusNotice {
  return {
    type: "stalled",
    task_id: "s~1",
    session_id: "s",
    last_activity_ts: 10_000,
    idle_seconds: 95,
    completed_steps: 3,
    last_success_action: "read",
    suspected_blocker: "工具 bash 已执行 95s 仍无输出增量",
    level: "low",
    seq: 1,
    created_at: 105_000,
    repeat: 0,
    message: "任务已 95 秒无有效进展",
    ...overrides,
  };
}

test("pickSessionTask prefers the active task, then the newest", () => {
  const active = task({ taskId: "s~1", sessionId: "s", startedAt: 1 });
  const finished = task({ taskId: "s~2", sessionId: "s", status: "completed", startedAt: 99 });
  const other = task({ taskId: "x~1", sessionId: "x", startedAt: 100 });
  assert.equal(pickSessionTask([finished, active, other], "s")?.taskId, "s~1");
  assert.equal(pickSessionTask([finished, other], "s")?.taskId, "s~2");
  assert.equal(pickSessionTask([other], "s"), null);
  assert.equal(pickSessionTask(undefined, "s"), null);
  assert.equal(pickSessionTask([active], null), null);
});

test("describeStall only fires past the threshold and escalates when marked stalled", () => {
  const fresh = task({ lastActivityAt: 10_000 });
  assert.equal(describeStall(fresh, { streaming: true, now: 20_000, stallMs: 90_000 }), null);

  const warn = describeStall(fresh, { streaming: true, now: 110_000, stallMs: 90_000 });
  assert.ok(warn);
  assert.equal(warn.level, "warn");
  assert.equal(warn.idleSeconds, 100);

  const stalled = describeStall(
    task({ status: "stalled", lastActivityAt: 10_000, suspectedBlocker: "卡在 bash" }),
    { streaming: true, now: 200_000, stallMs: 90_000 },
  );
  assert.ok(stalled);
  assert.equal(stalled.level, "stalled");
  assert.match(stalled.blocker, /卡在 bash/);

  // 已结束的行不因为任务停滞而改变等级判定语义：非 streaming 且未 stalled → 无提示
  assert.equal(describeStall(fresh, { streaming: false, now: 200_000 }), null);
  // 但任务真被标 stalled 时，行仍要能看到诊断
  assert.equal(describeStall(task({ status: "stalled" }), { streaming: false, now: 200_000 })?.level, "stalled");
});

test("sessionStatusDot only lights up for active tasks", () => {
  assert.equal(sessionStatusDot(null), null);
  assert.equal(sessionStatusDot(task({ status: "completed" })), null);
  assert.equal(sessionStatusDot(task())?.tone, "running");
  assert.equal(sessionStatusDot(task({ status: "stalled" }))?.tone, "stalled");
  assert.equal(sessionStatusDot(task({ status: "failed" }))?.tone, "failed");
});

test("stalled dot carries an actionable tooltip with the idle seconds", () => {
  const dot = sessionStatusDot(task({ status: "stalled", idleSeconds: 62 }));
  assert.equal(dot?.tooltip, "系统检测到该任务已停滞 62 秒");
  const failed = sessionStatusDot(task({ status: "failed", idleSeconds: 120 }));
  assert.equal(failed?.tooltip, "系统检测到该任务已失败（停滞 120 秒）");
  assert.match(sessionStatusDot(task({ status: "running", idleSeconds: 4 }))?.tooltip ?? "", /执行中/);
});

test("latestNoticeForSession returns the newest notice for that session/task", () => {
  const notices = [
    notice({ seq: 1, type: "stalled" }),
    notice({ seq: 2, type: "recovered", task_id: "s~2" }),
    notice({ seq: 3, session_id: "x" }),
  ];
  assert.equal(latestNoticeForSession(notices, "s")?.seq, 2);
  assert.equal(latestNoticeForSession(notices, "s", "s~1")?.seq, 1);
  assert.equal(latestNoticeForSession(notices, "nope"), null);
  assert.equal(latestNoticeForSession(undefined, "s"), null);
});

test("formatIdleSeconds never shows negative time", () => {
  assert.equal(formatIdleSeconds(-3), "刚刚");
  assert.equal(formatIdleSeconds(0), "刚刚");
  assert.equal(formatIdleSeconds(2), "2 秒前");
  assert.equal(formatIdleSeconds(95), "1 分 35 秒前");
});

test("panel light turns from red back to green once the intervention resets the task", () => {
  // 介入前的红灯
  assert.deepEqual(panelLight("s", task({ status: "stalled", idleSeconds: 95 })), {
    tone: "stalled",
    label: "无有效进展",
  });
  // Host 重置后（resetWatchdogAfterIntervention 返回 running + 新 lastActivityAt）
  assert.deepEqual(panelLight("s", task({ status: "running", lastActivityAt: 200_000 })), {
    tone: "running",
    label: "系统运行正常",
  });
  assert.equal(panelLight(null, task()).tone, "idle");
  assert.equal(panelLight("s", null).tone, "idle");
  assert.equal(panelLight("s", task({ status: "failed" })).tone, "failed");
  assert.equal(panelLight("s", task({ status: "completed" })).tone, "idle");
});

test("tool summary aggregates concurrent tools and heartbeat uses liveness", () => {
  assert.equal(toolSummary(null), null);
  assert.equal(toolSummary(task({ activeToolCount: 0 })), null);
  assert.equal(toolSummary(task({ activeToolCount: 1 })), "1 个工具执行中");
  assert.equal(toolSummary(task({ activeToolCount: 6 })), "6 个工具执行中");

  const view = task({ lastActivityAt: 10_000, lastLivenessAt: 40_000, activeToolCount: 6 });
  assert.equal(livenessSeconds(view, 42_000), 2, "心跳按 liveness 算（工具启动/输出都算）");
  assert.equal(livenessSeconds(view, 40_000), 0);
  assert.equal(livenessSeconds(null, 40_000), 0);
});

test("multi-session: A stalled while B runs — each surface reads only its own session", () => {
  const stalledA = task({ taskId: "A~1", sessionId: "A", status: "stalled", idleSeconds: 95 });
  const runningB = task({ taskId: "B~1", sessionId: "B", status: "running", idleSeconds: 3 });
  const tasks = [stalledA, runningB];

  // 左栏：A 红（stalled），B 蓝（running），各自独立。
  assert.equal(sessionStatusDot(pickSessionTask(tasks, "A"))?.tone, "stalled");
  assert.equal(sessionStatusDot(pickSessionTask(tasks, "B"))?.tone, "running");
  assert.equal(sessionStatusDot(null), null);

  // 右侧面板：停在 B 时显示 B 正常，切回 A 才变红（面板只读当前会话）。
  assert.equal(panelLight("B", pickSessionTask(tasks, "B")).tone, "running");
  assert.equal(panelLight("B", pickSessionTask(tasks, "B")).label, "系统运行正常");
  assert.equal(panelLight("A", pickSessionTask(tasks, "A")).tone, "stalled");
  assert.equal(panelLight("A", pickSessionTask(tasks, "A")).label, "无有效进展");

  // B 的数据不会被 A 的卡死污染。
  const viewB = pickSessionTask(tasks, "B")!;
  assert.equal(viewB.sessionId, "B");
  assert.equal(viewB.idleSeconds, 3);
});
