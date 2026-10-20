"use client";

import { useEffect, useState } from "react";

export type HostHealth = "unknown" | "ok" | "down";

/**
 * Lightweight host liveness probe for the existing status toast. It polls the
 * same `/api/health` endpoint the Electron launcher uses, so it also works in
 * browser-only development.
 */
export function useHostHealth(intervalMs = 5_000): HostHealth {
  const [host, setHost] = useState<HostHealth>("unknown");

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        const data = (await res.json()) as { host?: "ok" | "down" };
        if (!cancelled) setHost(data.host === "ok" ? "ok" : "down");
      } catch {
        if (!cancelled) setHost("down");
      }
    };
    void check();
    const id = window.setInterval(() => void check(), intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [intervalMs]);

  return host;
}
