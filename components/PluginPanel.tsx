"use client";

import { useCallback, useEffect, useState } from "react";
import { Puzzle } from "lucide-react";
import type { PluginView } from "@/contract/domains/plugins";

/**
 * Read-only panel injected by Host plugins. Plugin bodies are plain text:
 * nothing here interprets HTML, so a plugin cannot execute renderer script.
 */
export function PluginPanel() {
  const [plugins, setPlugins] = useState<PluginView[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/plugins", { cache: "no-store" });
      const data = (await response.json()) as { plugins?: PluginView[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      setPlugins((data.plugins ?? []).filter((plugin) => plugin.status === "loaded"));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 4_000);
    const onVisible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", load);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", load);
    };
  }, [load]);

  const panels = plugins.flatMap((plugin) => plugin.panels.map((panel) => ({ ...panel, pluginName: plugin.name })));

  return (
    <div className="flex h-full flex-col gap-1 overflow-y-auto px-1.5 py-1" data-testid="plugin-panel">
      {error && <p className="px-1.5 text-[11px] text-danger">{error}</p>}
      {panels.length === 0 ? (
        <p className="px-1.5 py-2 text-[11px] leading-5 text-ink-faint">
          <Puzzle size={12} className="mr-1 inline" aria-hidden="true" />
          没有插件注入面板。启用的插件可通过 <code className="font-mono text-[10.5px]">api.registerPanel()</code> 在此显示只读内容。
        </p>
      ) : panels.map((panel) => (
        <section key={panel.id} className="rounded-lg border border-[#E7E9EE] bg-white px-2.5 py-2">
          <div className="flex items-center gap-1.5">
            <Puzzle size={11} className="text-[#6B7280]" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink">{panel.title}</span>
            <span className="shrink-0 text-[9.5px] text-ink-faint">{panel.pluginName}</span>
          </div>
          <pre className="mt-1.5 whitespace-pre-wrap break-words font-mono text-[10.5px] leading-4 text-ink-muted">{panel.body || "(空面板)"}</pre>
        </section>
      ))}
    </div>
  );
}

export default PluginPanel;
