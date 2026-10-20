"use client";

import { useEffect, useState } from "react";

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

/**
 * Lightweight host liveness probe for the status dot and the existing toast.
 * Polls the same `/api/health` endpoint the Electron launcher uses, so it also
 * works in browser-only development.
 */
export function useHostHealth(intervalMs = 3_000): HostHealthStatus {
  const [status, setStatus] = useState<HostHealthStatus>(UNKNOWN);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        const data = (await res.json()) as {
          host?: "ok" | "down";
          hostState?: HostEngineState;
          hostDetail?: HostHealthDetail;
        };
        if (cancelled) return;
        if (data.host === "ok") {
          setStatus({ state: "ready", message: "后台引擎正常", detail: data.hostDetail });
          return;
        }
        setStatus(
          data.hostState === "reconnecting"
            ? { state: "reconnecting", message: "后台引擎断开，正在重连…" }
            : { state: "offline", message: "后台引擎离线，请检查进程状态" },
        );
      } catch {
        if (!cancelled) {
          setStatus({ state: "offline", message: "本地服务不可达，正在重试…" });
        }
      }
    };
    void check();
    const id = window.setInterval(() => void check(), intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [intervalMs]);

  return status;
}
