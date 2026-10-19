"use client";

import { useEffect, useRef } from "react";

/**
 * Subscribe to server-side `~/.pi/agent` config changes (see
 * lib/config-watcher.ts). EventSource reconnects on its own; we only surface
 * `config_changed` and ignore the initial `connected` frame.
 */
export function useConfigHotReload(onChange: () => void): void {
  const handlerRef = useRef(onChange);
  handlerRef.current = onChange;

  useEffect(() => {
    const source = new EventSource("/api/config/events");
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as { type?: string };
        if (data.type === "config_changed") handlerRef.current();
      } catch {
        // Ignore malformed frames / heartbeats.
      }
    };
    return () => source.close();
  }, []);
}
