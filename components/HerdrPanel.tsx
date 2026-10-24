"use client";

import { useCallback, useEffect, useState } from "react";
import { Bot, Loader2, Square } from "lucide-react";
import type { HerdrAgentView } from "@contract/domains/herdr";
import { ErrorNotice } from "./ErrorNotice";

function duration(agent: HerdrAgentView): string {
  const ms = agent.endedAt ? agent.durationMs : Date.now() - agent.startedAt;
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

const STATUS_COLOR: Record<string, string> = {
  starting: "#9A6B1F",
  running: "#2F7A55",
  stopping: "#9A6B1F",
  stopped: "#9CA3AF",
  crashed: "#B0443C",
  exited: "#9CA3AF",
};

/** Read-only Herdr fleet panel; lifecycle controls stay in the Host. */
export function HerdrPanel() {
  const [agents, setAgents] = useState<HerdrAgentView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);
  const [lastLoadedAt, setLastLoadedAt] = useState(() => Date.now());
  const [refreshCount, setRefreshCount] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/herdr", { cache: "no-store" });
      const data = (await res.json()) as { agents?: HerdrAgentView[]; error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setAgents(data.agents ?? []);
      setError(null);
      setLastLoadedAt(Date.now());
      setRefreshCount((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
    // 舰队有事件主题：优先实时推送，轮询只做断线兜底（原先是 2s 死轮询）。
    const source = new EventSource("/api/fleet/events");
    let live = false;
    source.onopen = () => {
      live = true;
    };
    source.onerror = () => {
      live = false;
    };
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as { type?: string; agents?: HerdrAgentView[] };
        if (data.type !== "fleet" || !data.agents) return;
        live = true;
        setAgents(data.agents);
        setError(null);
        setLastLoadedAt(Date.now());
      } catch {
        /* ignore malformed frame */
      }
    };
    const id = window.setInterval(() => {
      if (!live) void load();
    }, 5_000);
    // Chromium throttles timers in hidden/minimized windows. Refresh as soon
    // as the window becomes visible/focused again instead of waiting.
    const refresh = () => void load();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", refresh);
    return () => {
      source.close();
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pageshow", refresh);
    };
  }, [load]);

  const stop = async (id: string) => {
    setStopping(id);
    try {
      await fetch("/api/herdr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop", id }),
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStopping(null);
    }
  };

  return (
    <div
      className="flex flex-col gap-1 px-1.5 py-1"
      data-testid="herdr-panel"
      data-last-loaded-at={lastLoadedAt}
      data-refresh-count={refreshCount}
    >
      {error && (
        <ErrorNotice
          message={error}
          className="block px-1.5 text-[11px] text-danger"
          fallback={<span className="block px-1.5 py-1 text-[11px] text-ink-faint">正在等待本地引擎就绪…</span>}
        />
      )}
      {agents.length === 0 ? (
        <p className="px-1.5 py-2 text-[11px] leading-5 text-ink-faint">
          <Bot size={12} className="mr-1 inline" aria-hidden="true" />
          舰队为空。主 Agent 可用 <code className="font-mono text-[10.5px]">herdr_spawn</code> 派生持久子 Agent。
        </p>
      ) : (
        agents.map((agent) => (
          <div key={agent.id} className="rounded-lg border border-[#E7E9EE] bg-white px-2.5 py-2">
            <div className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: STATUS_COLOR[agent.status] ?? "var(--text-dim)" }} />
              <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink" title={agent.task}>{agent.name}</span>
              {(agent.status === "stopped" || agent.status === "crashed" || agent.activity === "idle") && (
                agent.verification.verified ? (
                  <span title={agent.verification.reason} className="rounded-full border border-[#CBE6D5] bg-[#F2FBF5] px-1.5 py-0.5 text-[9.5px] font-medium text-[#2F7A55]">已验证</span>
                ) : (
                  <span title={agent.verification.reason} className="rounded-full border border-[#F0E0C2] bg-[#FFF9EE] px-1.5 py-0.5 text-[9.5px] font-medium text-[#9A6B1F]">未验证</span>
                )
              )}
              <span className="shrink-0 text-[10px] text-ink-faint">{agent.status} / {agent.activity}</span>
              <span className="shrink-0 text-[10px] tabular-nums text-ink-faint">{duration(agent)}</span>
              {!["stopped", "crashed", "exited"].includes(agent.status) && (
                <button type="button" onClick={() => void stop(agent.id)} disabled={stopping === agent.id} title="停止舰队 Agent" aria-label={`停止 ${agent.name}`} className="flex h-4 w-4 items-center justify-center rounded text-ink-faint hover:bg-[#FDF6F5] hover:text-[#B0443C]">
                  {stopping === agent.id ? <Loader2 size={9} className="animate-spin" /> : <Square size={8} strokeWidth={0} fill="currentColor" />}
                </button>
              )}
            </div>
            <p className="mt-1 line-clamp-2 text-[10.5px] leading-4 text-ink-faint" title={agent.task}>{agent.task}</p>
            <p className="mt-1 truncate font-mono text-[10px] text-ink-muted">
              {agent.turns} turns · {agent.toolCalls.length} tool calls · {agent.verified ? "verified" : "unverified"}
            </p>
          </div>
        ))
      )}
    </div>
  );
}

export default HerdrPanel;
