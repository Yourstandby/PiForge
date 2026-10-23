/**
 * 无进展看门狗（Watchdog）+ 结构化状态通知。
 *
 * 硬约束（本文件的全部存在意义）：
 *   1. 纯程序层：`setInterval` + 状态机 + 内存队列。**没有任何模型调用**，
 *      也不 import 任何模型/会话发送接口 —— 这个模块连 `prompt()` 都碰不到；
 *   2. 绝不注入 prompt：通知只写进本模块的 `notices` 环形队列，通过
 *      `watchdog.status`（只读 RPC）给 Renderer 拉取，主 Agent 的
 *      system prompt / 对话历史 / 会话 JSONL 一个字节都不会被改写；
 *   3. 不阻塞主流程：观察者是同步的「读事件 → 更新计数」，扫描在独立定时器里
 *      跑（`.unref()`，不会拖住进程退出），主流程不 sleep、不轮询、不等待；
 *   4. 开关默认开启；`PIFORGE_WATCHDOG=0` 时既不建定时器也不记状态，
 *      `getWatchdogSnapshot()` 只回 `{ enabled: false, tasks: [], notices: [] }`，
 *      系统行为与改动前完全一致。
 */
import type {
  InterventionResult,
  StatusNotice,
  StatusNoticeKind,
  WatchdogConfigView,
  WatchdogSnapshot,
  WatchdogTaskStatus,
  WatchdogTaskView,
} from "../contract/domains/watchdog.ts";
import {
  describeSuspectedBlocker,
  ProgressTracker,
  type ProgressEvent,
  type TaskProgress,
} from "./progress-tracker.ts";
import {
  buildInterventionMessage,
  checkIntervention,
  type InterventionAction,
  type InterventionDelivery,
  type InterventionGuardResult,
} from "./intervention.ts";

export interface WatchdogConfig {
  enabled: boolean;
  /** 扫描周期。 */
  tickMs: number;
  /** 多久没有有效进展算「疑似卡顿」。 */
  stallMs: number;
  /** 连续多少次扫描无进展才升级成 stalled。 */
  stallScans: number;
  /** 升级后的退避重复通知间隔，用完之后标 failed。 */
  backoffMs: number[];
  /** 通知队列上限（只保留最近这么多条）。 */
  noticeLimit: number;
}

export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  enabled: true,
  tickMs: 10_000,
  stallMs: 20_000,
  stallScans: 3,
  backoffMs: [30_000, 60_000, 120_000],
  noticeLimit: 50,
};

function readBooleanFlag(raw: string | undefined): boolean | null {
  if (raw === undefined) return null;
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  if (["0", "false", "off", "no", "disable", "disabled"].includes(value)) return false;
  if (["1", "true", "on", "yes", "enable", "enabled"].includes(value)) return true;
  return null;
}

function readPositiveInt(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

/** 环境变量 → 配置。默认全开，值非法时回落到默认值（不抛错、不阻断启动）。 */
export function resolveWatchdogConfig(
  env: Record<string, string | undefined> = process.env,
): WatchdogConfig {
  return {
    ...DEFAULT_WATCHDOG_CONFIG,
    enabled: readBooleanFlag(env.PIFORGE_WATCHDOG) ?? DEFAULT_WATCHDOG_CONFIG.enabled,
    tickMs: readPositiveInt(env.PIFORGE_WATCHDOG_TICK_MS) ?? DEFAULT_WATCHDOG_CONFIG.tickMs,
    stallMs: readPositiveInt(env.PIFORGE_WATCHDOG_STALL_MS) ?? DEFAULT_WATCHDOG_CONFIG.stallMs,
    stallScans:
      readPositiveInt(env.PIFORGE_WATCHDOG_STALL_SCANS) ?? DEFAULT_WATCHDOG_CONFIG.stallScans,
  };
}

/** 运行期可调阈值区间（UI 下拉框只能落在这个范围内）。 */
export const WATCHDOG_STALL_MS_MIN = 5_000;
export const WATCHDOG_STALL_MS_MAX = 600_000;

let config: WatchdogConfig = resolveWatchdogConfig();
/** 可注入时钟：单测里推进时间不必真的等 90 秒。 */
let clock: () => number = Date.now;
let tracker = new ProgressTracker(clock);
let timer: ReturnType<typeof setInterval> | null = null;
let noticeSeq = 0;
const notices: StatusNotice[] = [];
const sessionCwd = new Map<string, string>();

/** 只读配置快照（给 UI 展示「已 N 秒无进展」里的 N）。 */
export function getWatchdogConfigView(): WatchdogConfigView {
  return {
    tickMs: config.tickMs,
    stallMs: config.stallMs,
    stallScans: config.stallScans,
    backoffMs: [...config.backoffMs],
  };
}

export function isWatchdogEnabled(): boolean {
  return config.enabled;
}

/**
 * 运行期调整「多久无有效进展算卡顿」（`watchdog.configure` 的唯一业务逻辑）。
 *
 * 只写内存配置：不重建定时器、不重置任务、不写任何文件，也不产生通知；
 * 同时把 running 任务的 staleScans 清零，让新阈值在下一个 tick 立即生效。
 */
export function setWatchdogStallMs(stallMs: number): WatchdogConfigView {
  const requested = Math.round(stallMs);
  if (!Number.isFinite(requested)) throw new RangeError("stallMs must be a finite number");
  const clamped = Math.min(WATCHDOG_STALL_MS_MAX, Math.max(WATCHDOG_STALL_MS_MIN, requested));
  config = { ...config, stallMs: clamped };
  for (const task of tracker.activeTasks()) {
    if (task.status === "running") task.staleScans = 0;
  }
  return getWatchdogConfigView();
}

function pushNotice(
  kind: StatusNoticeKind,
  task: TaskProgress,
  now: number,
  repeat: number,
  overrides?: { message?: string },
): StatusNotice {
  noticeSeq += 1;
  // 并发时取「任务级无进展」与「最久工具无输出」的更久者，通知里的数字才是真实等待时长。
  const idleSeconds = Math.max(
    Math.max(0, Math.round((now - task.lastActivityAt) / 1000)),
    ProgressTracker.toolIdleSeconds(task, now),
  );
  const blocker = describeSuspectedBlocker(task, now);
  const message =
    kind === "stalled"
      ? repeat === 0
        ? `任务已 ${idleSeconds} 秒无有效进展，已记录异步诊断通知（主流程未阻塞）`
        : `任务仍无进展（第 ${repeat} 次退避提醒，已 ${idleSeconds} 秒）`
      : kind === "recovered"
        ? `任务已恢复输出（停滞 ${idleSeconds} 秒后重新有进展）`
        : `任务连续 ${idleSeconds} 秒无进展，已标记失败（仅界面标记，未干预模型）`;
  const notice: StatusNotice = {
    type: kind,
    task_id: task.taskId,
    session_id: task.sessionId,
    ...(task.cwd ? { cwd: task.cwd } : {}),
    last_activity_ts: task.lastActivityAt,
    idle_seconds: idleSeconds,
    completed_steps: task.completedSteps,
    last_success_action: task.lastSuccessAction,
    suspected_blocker: blocker,
    level: "low",
    seq: noticeSeq,
    created_at: now,
    repeat,
    message,
  };
  if (overrides?.message) notice.message = overrides.message;
  notices.push(notice);
  if (notices.length > config.noticeLimit) notices.splice(0, notices.length - config.noticeLimit);
  task.noticeCount += 1;
  return notice;
}

/**
 * 一次扫描。导出是为了单测能直接推进时间，不必真的等 90 秒。
 * 返回本次新产生的通知（正常情况下调用方忽略它，队列才是真正的投递口）。
 */
export function runWatchdogTick(now: number = clock()): StatusNotice[] {
  if (!config.enabled) return [];
  const emitted: StatusNotice[] = [];
  for (const task of tracker.activeTasks()) {
    const idle = now - task.lastActivityAt;
    // 并发：只要有一个工具超阈，就算「卡住」。
    const blockedTool = ProgressTracker.hasBlockedTool(task, now, config.stallMs);
    if (task.status === "running") {
      if (!blockedTool && idle <= config.stallMs) {
        task.staleScans = 0;
        continue;
      }
      task.staleScans += 1;
      // 任务级无进展 → 需要连续 stallScans 次确认；
      // 单个工具已超阈 → 它已经比阈值还久没输出了，第一次扫描就升级。
      const needed = blockedTool ? 1 : config.stallScans;
      if (task.staleScans < needed) continue;
      // 升级 stalled + 首次通知。
      task.status = "stalled";
      task.repeats = 0;
      emitted.push(pushNotice("stalled", task, now, 0));
      task.nextNoticeAt = now + (config.backoffMs[0] ?? config.stallMs);
      continue;
    }
    // stalled：按 [30s, 60s, 120s] 退避重复，用完再标 failed。
    if (task.nextNoticeAt !== null && now >= task.nextNoticeAt) {
      if (task.repeats < config.backoffMs.length) {
        task.repeats += 1;
        emitted.push(pushNotice("stalled", task, now, task.repeats));
        const nextDelay =
          config.backoffMs[task.repeats] ?? config.backoffMs[config.backoffMs.length - 1] ?? config.stallMs;
        task.nextNoticeAt = now + nextDelay;
      } else {
        task.status = "failed";
        task.nextNoticeAt = null;
        emitted.push(pushNotice("failed", task, now, task.repeats));
      }
    }
  }
  return emitted;
}

function ensureTimer(): void {
  if (!config.enabled || timer) return;
  timer = setInterval(() => {
    try {
      runWatchdogTick();
    } catch (error) {
      // 看门狗自己绝不能把 Host 拖死。
      console.error("[watchdog] tick failed:", error);
    }
  }, config.tickMs);
  // 不阻止进程退出。
  timer.unref?.();
}

function stopTimer(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

/** 会话起步时登记 cwd（仅用于通知/UI 归属，不参与判定）。 */
export function registerWatchSession(sessionId: string, cwd?: string): void {
  if (!config.enabled || !sessionId) return;
  if (cwd) sessionCwd.set(sessionId, cwd);
  ensureTimer();
}

export function forgetWatchSession(sessionId: string): void {
  if (!config.enabled || !sessionId) return;
  tracker.forgetSession(sessionId);
  sessionCwd.delete(sessionId);
}

/**
 * 观测一条 pi 事件。**唯一的写入口**，同步、O(1)、无 IO：
 * 调用方（rpc-manager）在转发事件前顺手调一下即可，不会影响事件流本身。
 */
export function observeAgentEvent(sessionId: string, event: ProgressEvent): void {
  if (!config.enabled || !sessionId) return;
  ensureTimer();
  const observed = tracker.observe(sessionId, event, sessionCwd.get(sessionId));
  if (!observed) return;
  if (observed.recovered) pushNotice("recovered", observed.task, clock(), 0);
}

function toView(task: TaskProgress, now: number): WatchdogTaskView {
  const tools = task.runningTools.map((tool) => {
    const idleMs = Math.max(0, now - tool.lastOutputAt);
    return {
      toolCallId: tool.toolCallId,
      name: tool.name,
      startedAt: tool.startedAt,
      runningSeconds: Math.max(0, Math.round((now - tool.startedAt) / 1000)),
      idleSeconds: Math.round(idleMs / 1000),
      hasOutput: tool.hasOutput,
      overThreshold: idleMs > config.stallMs,
    };
  });
  const toolIdleSeconds = ProgressTracker.toolIdleSeconds(task, now);
  const progressIdle = Math.max(0, Math.round((now - task.lastActivityAt) / 1000));
  return {
    taskId: task.taskId,
    sessionId: task.sessionId,
    ...(task.cwd ? { cwd: task.cwd } : {}),
    status: task.status,
    startedAt: task.startedAt,
    lastActivityAt: task.lastActivityAt,
    lastAttemptAt: task.lastAttemptAt,
    lastLivenessAt: task.lastLivenessAt,
    // 展示用：任务级与工具级取更久的那一个（并发卡住时不会显示成 0 秒）。
    idleSeconds: Math.max(progressIdle, toolIdleSeconds),
    activeToolCount: tools.length,
    toolIdleSeconds,
    tools: tools.slice(0, 8),
    completedSteps: task.completedSteps,
    attempts: task.attempts,
    failedAttempts: task.failedAttempts,
    duplicateAttempts: task.duplicateAttempts,
    lastSuccessAction: task.lastSuccessAction,
    lastError: task.lastError,
    suspectedBlocker: describeSuspectedBlocker(task, now),
    pendingTool: task.pendingTool,
    noticeCount: task.noticeCount,
    interventionCount: task.interventions,
    lastInterventionAt: task.lastInterventionAt,
  };
}

/** 只读快照：UI 每秒拉一次，Host 侧不做任何写操作。 */
export function getWatchdogSnapshot(now: number = clock()): WatchdogSnapshot {
  if (!config.enabled) return { enabled: false, config: null, tasks: [], notices: [] };
  return {
    enabled: true,
    config: getWatchdogConfigView(),
    tasks: tracker.allTasks().map((task) => toView(task, now)),
    notices: [...notices],
  };
}

/** `get_task_status(task_id)`：A/B 需求的只读查询口。 */
export function getTaskStatus(taskId: string, now: number = clock()): WatchdogTaskView | null {
  if (!config.enabled) return null;
  const task = tracker.getTask(taskId);
  return task ? toView(task, now) : null;
}

/** 某个会话当前任务的只读视图（UI 面板与介入前校验用）。 */
export function getSessionTaskView(
  sessionId: string,
  now: number = clock(),
): WatchdogTaskView | null {
  if (!config.enabled || !sessionId) return null;
  const task = tracker.taskOf(sessionId);
  return task ? toView(task, now) : null;
}

/**
 * 介入前的守卫：防重复点击、防刷屏、防对已完成任务下手。
 * 纯判定，不产生任何副作用。
 */
export function guardIntervention(
  sessionId: string,
  actionType: InterventionAction,
  now: number = clock(),
): InterventionGuardResult {
  if (!config.enabled) return { allowed: true };
  const task = tracker.taskOf(sessionId);
  return checkIntervention({
    actionType,
    taskStatus: task?.status ?? null,
    now,
    lastInterventionAt: task?.lastInterventionAt ?? null,
    lastInterventionAction: task?.lastInterventionAction ?? null,
    interventions: task?.interventions ?? 0,
  });
}

/** 介入指令的原文（`ask` 需要拼上最后成功动作）。 */
export function interventionMessage(
  sessionId: string,
  actionType: InterventionAction,
): string {
  const task = tracker.taskOf(sessionId);
  return buildInterventionMessage(actionType, task?.lastSuccessAction ?? null);
}

/** 介入审计文案：三种动作各自说清楚注入了什么，便于排查 Token 花在哪。 */
const INTERVENTION_NOTICE: Record<InterventionAction, string> = {
  skip: "人工介入（强制跳过）：已注入跳过指令，看门狗计时已重置",
  ask_brief: "人工介入（极简询问）：已注入单句追问（禁止新增工具），看门狗计时已重置",
  ask: "人工介入（深度诊断）：已注入诊断追问（允许查状态），看门狗计时已重置",
};

/**
 * 介入后强制重置看门狗：状态回 running、退避/扫描计数清零、
 * 活动时间重计，并发一条 `recovered` 通知作为审计痕迹。
 *
 * 注意：这里只改看门狗自己的内存状态，**不碰会话历史**；
 * 真正写进对话的是调用方已经注入的那条介入指令。
 */
export function resetWatchdogAfterIntervention(
  sessionId: string,
  actionType: InterventionAction,
  now: number = clock(),
): WatchdogTaskView | null {
  if (!config.enabled) return null;
  const task = tracker.markIntervened(sessionId, actionType, now);
  if (!task) return null;
  pushNotice("recovered", task, now, 0, {
    message: INTERVENTION_NOTICE[actionType],
  });
  return toView(task, now);
}

/** 单测 / 调试用：整体重置（定时器、队列、任务）。 */
export function resetWatchdogForTest(next?: Partial<WatchdogConfig>): void {
  stopTimer();
  tracker.clear();
  notices.length = 0;
  noticeSeq = 0;
  sessionCwd.clear();
  config = { ...DEFAULT_WATCHDOG_CONFIG, ...next };
}

/** 单测用：注入伪时钟（会重建 tracker，保证时间基准一致）。 */
export function setWatchdogClockForTest(now: () => number): void {
  clock = now;
  tracker = new ProgressTracker(clock);
}

/** 单测用：临时替换配置（不重建定时器）。 */
export function setWatchdogConfigForTest(partial: Partial<WatchdogConfig>): void {
  config = { ...config, ...partial };
}

/** 单测用：当前任务状态快照（不经过 JSON 归一）。 */
export function watchTaskForTest(sessionId: string): TaskProgress | undefined {
  return tracker.taskOf(sessionId);
}

/** 单测用：显式启动定时器（验证「关闭时不建定时器」）。 */
export function watchdogTimerActiveForTest(): boolean {
  return timer !== null;
}

/** Host 关闭时停掉扫描定时器。 */
export function stopWatchdogTimer(): void {
  stopTimer();
}

export function stopWatchdogForTest(): void {
  stopTimer();
}

export function taskStatusLabel(status: WatchdogTaskStatus): string {
  switch (status) {
    case "running":
      return "执行中";
    case "stalled":
      return "无进展";
    case "failed":
      return "已失败";
    default:
      return "已完成";
  }
}

/** `agent.intervene` 只需要会话具备这一个能力（便于单测注入假会话）。 */
export interface InterventionTarget {
  deliverIntervention(message: string): Promise<{ delivered: InterventionDelivery }>;
}

/**
 * 一次人工介入的完整编排：守卫 → 拼文案 → 注入 → 重置看门狗。
 *
 * 这个函数是 `agent.intervene` 的全部业务逻辑（server.ts 只负责参数校验），
 * 因此可以脱离真实 Agent 做单测：传一个假会话就能验证「队列收到了什么」
 * 以及「状态确实回到了 running」。
 */
export async function performIntervention(input: {
  sessionId: string;
  actionType: InterventionAction;
  session: InterventionTarget;
  now?: number;
}): Promise<InterventionResult> {
  const { sessionId, actionType, session } = input;
  const at = input.now ?? clock();

  if (!config.enabled) {
    // 开关关闭时不发任何东西，也不假装重置。
    return {
      ok: false,
      actionType,
      delivered: "queue",
      message: "",
      task: null,
      rejected: "no_active_task",
      detail: "看门狗已关闭（PIFORGE_WATCHDOG=0），介入功能不可用。",
    };
  }

  const guard = guardIntervention(sessionId, actionType, at);
  if (!guard.allowed) {
    return {
      ok: false,
      actionType,
      delivered: "queue",
      message: "",
      task: getSessionTaskView(sessionId, at),
      ...(guard.reason ? { rejected: guard.reason } : {}),
      ...(guard.detail ? { detail: guard.detail } : {}),
    };
  }

  const message = interventionMessage(sessionId, actionType);
  const { delivered } = await session.deliverIntervention(message);
  // 注入成功 → 立刻把告警状态重置（红灯变绿、心跳重新计）。
  const task = resetWatchdogAfterIntervention(sessionId, actionType, at);
  return {
    ok: true,
    actionType,
    delivered,
    message,
    task,
    detail:
      actionType === "skip"
        ? "已向 Agent 发送跳过指令，看门狗计时已重置"
        : "已向 Agent 发送询问，看门狗计时已重置",
  };
}
