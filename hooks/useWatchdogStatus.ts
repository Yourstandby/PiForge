"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type {
  InterventionActionType,
  InterventionResult,
  StatusNotice,
  WatchdogConfigView,
  WatchdogSnapshot,
  WatchdogTaskView,
} from "../contract/domains/watchdog";
import {
  describeStall,
  latestNoticeForSession,
  pickSessionTask,
  sessionStatusDot,
  stallMsOf,
  type StallView,
} from "../lib/watchdog-view";

/**
 * 看门狗状态读取（Renderer 侧）。
 *
 * 全部数据来自只读接口 `/api/watchdog` → Host `watchdog.status`；这里
 * **不发消息、不发 prompt、不碰会话状态**，所以无论 UI 怎么刷新都不会
 * 产生任何模型调用。
 *
 * 性能取舍：
 *   - 模块级单例轮询（`useSyncExternalStore`），无论开多少个面板都只有一条
 *     请求链；窗口隐藏时不发请求；
 *   - 只有「任务状态 / 最后活动时间 / 通知数」变化时才 publish，
 *     `idle_seconds` 这种逐秒变化的派生量交给各组件自己的本地时钟算，
 *     避免每秒让整棵对话树重渲染；
 *   - Host 回报 `enabled: false`（开关关闭）后彻底停止轮询，
 *     行为与没有这个功能时一致。
 */
export interface WatchdogStoreState {
  /** 是否已经成功拿到过一次快照。 */
  ready: boolean;
  /** Host 侧开关；未就绪时按 true 处理（避免首帧闪白）。 */
  enabled: boolean;
  tasks: WatchdogTaskView[];
  notices: StatusNotice[];
  config: WatchdogConfigView | null;
}

const INITIAL: WatchdogStoreState = {
  ready: false,
  enabled: true,
  tasks: [],
  notices: [],
  config: null,
};

const ACTIVE_MS = 1_000;
const IDLE_MS = 4_000;
const RETRY_MS = 8_000;
/** 连续失败这么多次后降到慢速重试（对方 Host 旧版本 / 正在重启都不要永久放弃）。 */
const MAX_FAILURES = 5;
/** 慢速重试间隔：坏掉的 Host 也不会被刷屏，恢复后又能自己活过来。 */
const SLOW_RETRY_MS = 15_000;

let current: WatchdogStoreState = INITIAL;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;
/** Host 明确回报「看门狗已关闭」：不再轮询，直到用户主动刷新（打开面板）。 */
let hostDisabled = false;
let inFlight = false;
let failures = 0;

function emit(): void {
  for (const listener of listeners) listener();
}

function signatureOf(state: WatchdogStoreState): string {
  const tasks = state.tasks
    .map(
      (task) =>
        `${task.taskId}:${task.status}:${task.lastActivityAt}:${task.completedSteps}:${task.failedAttempts}:${task.attempts}:${task.pendingTool ?? ""}`,
    )
    .join("|");
  const lastNotice = state.notices.length ? state.notices[state.notices.length - 1].seq : 0;
  return `${state.ready}:${state.enabled}:${tasks}#${lastNotice}`;
}

function publish(next: WatchdogStoreState): void {
  // 数据等价：保留旧引用、不发通知，避免每秒都让 React 重渲染。
  if (signatureOf(current) === signatureOf(next)) return;
  current = next;
  emit();
}

function hasActiveTask(state: WatchdogStoreState): boolean {
  return state.tasks.some((task) => task.status === "running" || task.status === "stalled");
}

function schedule(delayMs: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void pollOnce();
  }, delayMs);
}

async function pollOnce(): Promise<void> {
  if (!started || hostDisabled) return;
  if (typeof document !== "undefined" && document.hidden) {
    schedule(IDLE_MS);
    return;
  }
  if (inFlight) return;
  inFlight = true;
  try {
    const res = await fetch("/api/watchdog", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const snapshot = (await res.json()) as WatchdogSnapshot;
    failures = 0;
    const next: WatchdogStoreState = {
      ready: true,
      enabled: snapshot?.enabled !== false,
      tasks: Array.isArray(snapshot?.tasks) ? snapshot.tasks : [],
      notices: Array.isArray(snapshot?.notices) ? snapshot.notices : [],
      config: snapshot?.config ?? null,
    };
    publish(next);
    if (!next.enabled) {
      // Host 说关掉了：安静停住，别每秒打一个没用请求。
      hostDisabled = true;
      stopPolling();
      return;
    }
    schedule(hasActiveTask(next) ? ACTIVE_MS : IDLE_MS);
  } catch {
    failures += 1;
    // 绝不永久放弃：Host 重启 / 旧版本不认识 watchdog.status 时只降速，
    // 一旦对面恢复（或用户打开面板触发 refresh），轮询会自动回到 1s。
    schedule(
      failures >= MAX_FAILURES ? SLOW_RETRY_MS : failures >= 3 ? RETRY_MS : ACTIVE_MS,
    );
  } finally {
    inFlight = false;
  }
}

function startPolling(): void {
  if (started || hostDisabled) return;
  started = true;
  void pollOnce();
}

function stopPolling(): void {
  started = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  startPolling();
  return () => {
    listeners.delete(listener);
    // 保留最后一次快照；没有订阅者就不再轮询。
    if (listeners.size === 0) stopPolling();
  };
}

function getSnapshot(): WatchdogStoreState {
  return current;
}

function getServerSnapshot(): WatchdogStoreState {
  return INITIAL;
}

/** 整个快照（UI 少用；优先用下面的选择器钩子）。 */
export function useWatchdogStore(): WatchdogStoreState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** 某个会话当前任务（只读）。 */
export function useWatchdogTask(sessionId: string | null | undefined): WatchdogTaskView | null {
  const state = useWatchdogStore();
  return useMemo(() => pickSessionTask(state.tasks, sessionId), [state.tasks, sessionId]);
}

/** 某个会话最近一条通知。 */
export function useWatchdogNotice(
  sessionId: string | null | undefined,
  taskId?: string | null,
): StatusNotice | null {
  const state = useWatchdogStore();
  return useMemo(
    () => latestNoticeForSession(state.notices, sessionId, taskId),
    [state.notices, sessionId, taskId],
  );
}

/** 左侧列表状态灯。 */
export function useSessionStatusDot(sessionId: string | null | undefined) {
  const task = useWatchdogTask(sessionId);
  return useMemo(() => sessionStatusDot(task), [task]);
}

/** 本地时钟：让「最后活动: N 秒前」自己跳，不牵动上层的轮询快照。 */
export function useTicker(active: boolean, intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const handle = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(handle);
  }, [active, intervalMs]);
  return now;
}

/**
 * 工具行的卡顿视图：`streaming` 时按本地时钟算 idle，只有跨过阈值 /
 * 被看门狗升级成 stalled 时才返回内容。
 */
export function useToolStall(
  sessionId: string | null | undefined,
  streaming: boolean,
): StallView | null {
  const state = useWatchdogStore();
  const task = useMemo(() => pickSessionTask(state.tasks, sessionId), [state.tasks, sessionId]);
  const stalled = task?.status === "stalled" || task?.status === "failed";
  const now = useTicker(Boolean(streaming) || stalled);
  return useMemo(
    () => describeStall(task, { streaming, now, stallMs: stallMsOf(state) }),
    [task, streaming, now, state],
  );
}

/** 心跳条的上下文值：当前任务 + 本地时钟。 */
export function useHeartbeat(sessionId: string | null | undefined) {
  const state = useWatchdogStore();
  const task = useMemo(() => pickSessionTask(state.tasks, sessionId), [state.tasks, sessionId]);
  const active = Boolean(task && (task.status === "running" || task.status === "stalled"));
  const now = useTicker(active);
  const idleSeconds = task ? Math.max(0, Math.round((now - task.lastActivityAt) / 1000)) : 0;
  const notice = useMemo(
    () => latestNoticeForSession(state.notices, sessionId, task?.taskId ?? null),
    [state.notices, sessionId, task],
  );
  return { enabled: state.enabled, ready: state.ready, task, notice, idleSeconds, stallMs: stallMsOf(state) };
}

/** 单测 / HMR 用：重置模块级轮询状态。 */
export function resetWatchdogStoreForTest(): void {
  stopPolling();
  current = INITIAL;
  failures = 0;
  hostDisabled = false;
  inFlight = false;
  listeners.clear();
}

/** 供组件按需手动刷新（例如点开诊断弹窗时）。 */
export function refreshWatchdog(): void {
  if (inFlight) return;
  hostDisabled = false;
  failures = 0;
  started = true;
  void pollOnce();
}

/**
 * 标签页重新可见 / 窗口回到前台时补一次：休眠期间的定时器会被浏览器压制，
 * 回来时快照可能已经过期（例如任务早就 stalled 了）。
 * 只在已有订阅者时生效，不给没人看的页面发请求。
 */
if (typeof document !== "undefined" && typeof window !== "undefined") {
  const wake = () => {
    if (listeners.size === 0) return;
    if (document.hidden) return;
    refreshWatchdog();
  };
  document.addEventListener("visibilitychange", wake);
  window.addEventListener("focus", wake);
}

export function useWatchdogRefreshOnOpen(open: boolean): void {
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current) refreshWatchdog();
    wasOpen.current = open;
  }, [open]);
}

/**
 * 停滞阈值预设（毫秒）：与 Host 的 5s ~ 10min 合法区间兼容。
 * 面板下拉框只暴露这四个值，避免用户填出奇怪数字。
 */
export const STALL_MS_PRESETS = [15_000, 30_000, 60_000, 90_000] as const;

const STALL_MS_KEY = "piforge.watchdog.stallMs";

/** 读上次选择的阈值（Host 重启会回落默认 20s，面板挂载后靠这里回写）。 */
export function readStoredStallMs(): number | null {
  if (typeof window === "undefined") return null;
  const raw = Number(window.localStorage.getItem(STALL_MS_KEY));
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

/**
 * 调整停滞阈值：POST `/api/watchdog` → Host `watchdog.configure`。
 *
 * 只是改一个内存里的数字，不重建定时器、不重启 Host、不产生通知；
 * 成功后本地记一笔并立即刷新快照，让面板显示马上跟随。
 */
export async function configureStallMs(stallMs: number): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch("/api/watchdog", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stallMs }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      return { ok: false, error: data?.error ?? `HTTP ${res.status}` };
    }
    if (typeof window !== "undefined") window.localStorage.setItem(STALL_MS_KEY, String(stallMs));
    refreshWatchdog();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 人工介入：POST 到只读代理旁边的 `/api/agent/[id]/intervene`。
 *
 * 指令注入 + 看门狗重置都在 Host 完成；这里发完立刻刷新一次快照，
 * 让红灯在 1 秒轮询之前就变绿。
 */
export async function requestIntervention(
  sessionId: string,
  actionType: InterventionActionType,
): Promise<InterventionResult> {
  const res = await fetch(`/api/agent/${encodeURIComponent(sessionId)}/intervene`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actionType }),
  });
  const data = (await res.json().catch(() => null)) as (InterventionResult & { error?: string }) | null;
  if (!res.ok || !data) {
    return {
      ok: false,
      actionType,
      delivered: "queue",
      message: "",
      task: null,
      detail: data?.error ?? `HTTP ${res.status}`,
    };
  }
  // 介入后状态已被 Host 重置，立即拉一次，不等下一个轮询周期。
  refreshWatchdog();
  return data;
}
