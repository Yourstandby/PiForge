"use client";

import { useEffect, useSyncExternalStore } from "react";

export type HostEngineState = "unknown" | "ready" | "reconnecting" | "offline";

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
      publish({ state: "ready", message: "后台引擎正常", detail: data.hostDetail });
    } else {
      publish(
        data.hostState === "reconnecting"
          ? { state: "reconnecting", message: "后台引擎断开，正在重连…" }
          : { state: "offline", message: "后台引擎离线，请检查进程状态" },
      );
    }
  } catch {
    publish({ state: "offline", message: "本地服务不可达，正在重试…" });
  } finally {
    inFlight = false;
  }
}

function startPolling(intervalMs: number) {
  if (timer !== null) return;
  void probeOnce();
  timer = setInterval(() => void probeOnce(), intervalMs);
}

function stopPolling() {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
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
