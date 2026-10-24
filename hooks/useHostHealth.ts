"use client";

import { useEffect, useSyncExternalStore } from "react";

export type HostEngineState = "unknown" | "starting" | "ready" | "reconnecting" | "offline";

export interface HostHealthDetail {
  pid: number;
  uptimeMs: number;
  protocolVersion: number;
  sessions: number;
  processes: number;
}

export interface HostHealthStatus {
  state: HostEngineState;
  message: string;
  detail?: HostHealthDetail;
}

const UNKNOWN: HostHealthStatus = {
  state: "unknown",
  message: "正在检查后台引擎…",
};

const DEFAULT_INTERVAL_MS = 3_000;

/**
 * 冷启动期间的确认次数：Host 还在加载时 `/api/health` 一直回 `down`，
 * 连续 3 次（约 6s）仍为 down 之后，才允许把它当成"真的离线"。
 *
 * 0.9.0 的问题不在轮询快慢，而在语义：首帧就报"断开，正在重连"，用户会去点重启。
 */
const BOOT_CONFIRM_PROBES = 3;

/**
 * Single shared probe for host liveness.
 *
 * Every open chat tab used to run its own 3s `setInterval` → N panes opened
 * N parallel `/api/health` round-trips through the named pipe to the Host,
 * which is a real chunk of the "切换会话时 IPC 卡顿". One module-level poll +
 * `useSyncExternalStore` keeps it at exactly one request per interval no
 * matter how many panes are mounted, and stops it when nobody is listening.
 *
 * 注：这里只用模块级单例，不挂 globalThis —— 客户端 HMR 重载时多一个旧
 * interval 也无害（订阅归零即清），而复用 globalThis 反而容易出现双轮询。
 */
let current: HostHealthStatus = UNKNOWN;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;
/** 连续看到 host=down 的次数（用来区分"正在启动"和"真的离线"）。 */
let downProbes = 0;

/**
 * Electron preload 广播的 Host 就绪状态（Main 侧的权威状态）。
 *
 * 它比 `/api/health` 快而且准确：Host 就绪的那一刻 Main 就知道，而渲染进程的
 * 3s 轮询最多要等一个周期。两者同时存在时 Electron 事件优先；浏览器开发模式
 * 没有这个通道，自动回退到健康检查。
 */
let unsubscribeElectron: (() => void) | null = null;

function subscribeElectronHostState(): () => void {
  if (typeof window === "undefined") return () => {};
  const api = (window as {
    electronAPI?: {
      onHostState?: (cb: (snapshot: { state: string; label: string; blocking: boolean }) => void) => () => void;
      getHostState?: () => Promise<{ state: string; label: string; blocking: boolean } | null>;
    };
  }).electronAPI;
  if (!api?.onHostState) return () => {};
  const apply = (snapshot: { state: string; label: string; blocking: boolean } | null) => {
    if (!snapshot) return;
    if (snapshot.state === "ready") {
      downProbes = 0;
      publish({ state: "ready", message: snapshot.label || "后台引擎正常" });
      return;
    }
    if (snapshot.state === "booting" || snapshot.state === "degraded") {
      publish({ state: "starting", message: snapshot.label || "后台引擎启动中…" });
      return;
    }
    // Main 说引擎不在了（进程退出/启动失败）：交给健康检查确认。
    publish({ state: "offline", message: snapshot.label || "后台引擎不可用" });
  };
  const off = api.onHostState(apply);
  void api.getHostState?.().then(apply).catch(() => {});
  return off;
}

function emit() {
  for (const listener of listeners) listener();
}

function publish(next: HostHealthStatus) {
  const same =
    current.state === next.state &&
    current.message === next.message &&
    current.detail?.pid === next.detail?.pid &&
    current.detail?.uptimeMs === next.detail?.uptimeMs &&
    current.detail?.sessions === next.detail?.sessions &&
    current.detail?.processes === next.detail?.processes;
  if (same) return;
  current = next;
  emit();
}

async function probeOnce() {
  if (inFlight) return;
  inFlight = true;
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    const data = (await res.json()) as {
      host?: "ok" | "down";
      hostState?: HostEngineState;
      hostDetail?: HostHealthDetail;
    };
    if (data.host === "ok") {
      downProbes = 0;
      publish({ state: "ready", message: "后台引擎正常", detail: data.hostDetail });
      return;
    }
    downProbes += 1;
    if (data.hostState === "starting" || downProbes <= BOOT_CONFIRM_PROBES) {
      // 启动窗口内不报"断开"：这就是 0.9.0 冷启动 UI 看起来像崩了的原因。
      publish({ state: "starting", message: "后台引擎启动中（界面已就绪，可先看会话）" });
      return;
    }
    publish(
      data.hostState === "reconnecting"
        ? { state: "reconnecting", message: "后台引擎断开，正在重连…" }
        : { state: "offline", message: "后台引擎离线，请检查进程状态" },
    );
  } catch {
    downProbes += 1;
    publish(
      downProbes <= BOOT_CONFIRM_PROBES
        ? { state: "starting", message: "本地服务启动中…" }
        : { state: "offline", message: "本地服务不可达，正在重试…" },
    );
  } finally {
    inFlight = false;
  }
}

function startPolling(intervalMs: number) {
  if (timer !== null) return;
  void probeOnce();
  timer = setInterval(() => void probeOnce(), intervalMs);
  unsubscribeElectron = subscribeElectronHostState();
}

function stopPolling() {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
  unsubscribeElectron?.();
  unsubscribeElectron = null;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  startPolling(DEFAULT_INTERVAL_MS);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stopPolling();
  };
}

function getSnapshot() {
  return current;
}

function getServerSnapshot() {
  return UNKNOWN;
}

/**
 * Lightweight host liveness probe for the status dot and the existing toast.
 * Polls the same `/api/health` endpoint the Electron launcher uses, so it also
 * works in browser-only development.
 *
 * `intervalMs` is kept for API compatibility but the shared poller runs at the
 * default cadence (one timer for the whole renderer).
 */
export function useHostHealth(intervalMs: number = DEFAULT_INTERVAL_MS): HostHealthStatus {
  const status = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    if (intervalMs === DEFAULT_INTERVAL_MS) return;
    // 非默认节奏：仅当已有订阅者时切换全局定时器，保持「全局只有一条轮询」。
    stopPolling();
    startPolling(intervalMs);
    return () => {
      stopPolling();
      if (listeners.size > 0) startPolling(DEFAULT_INTERVAL_MS);
    };
  }, [intervalMs]);

  return status;
}
