"use client";

import { useCallback, useEffect, useState } from "react";
import { Bot, ChevronDown, Loader2, Square } from "lucide-react";
import type { SubagentStatus, SubagentView } from "@contract/domains/subagents";

const STATUS_DOT: Record<SubagentStatus, string> = {
  running: "#3E8A63",
  completed: "#2563EB",
  failed: "#C2554E",
  cancelled: "#9CA3AF",
};

const STATUS_LABEL: Record<SubagentStatus, string> = {
  running: "Running",
  completed: "Idle",
  failed: "Failed",
  cancelled: "Cancelled",
};

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${rest}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function toolSummary(agent: SubagentView): string {
  const calls = agent.toolCalls;
  if (calls.length === 0) return "";
  const running = calls.filter((call) => call.status === "running");
  const tail = running.length > 0 ? running : calls.slice(-3);
  return tail.map((call) => call.name).join(" · ");
}

function SubagentCard({
  agent,
  onStop,
  now,
}: {
  agent: SubagentView;
  onStop: (id: string) => void;
  now: number;
}) {
  const running = agent.status === "running";
  const [open, setOpen] = useState(running);
  const duration = running ? Math.max(0, now - agent.startedAt) : agent.durationMs;
  const tools = toolSummary(agent);

  return (
    <div className="mx-1.5 mb-1.5 rounded-lg border border-[#E7E9EE] bg-white px-2.5 py-2 shadow-[0_1px_2px_rgba(17,17,17,0.03)]">
      <div className="flex items-center gap-1.5">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${running ? "animate-pulse" : ""}`}
          style={{ background: STATUS_DOT[agent.status] }}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink" title={agent.task}>
          {agent.name}
        </span>
        <span
          className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[9.5px] font-medium ${
            running
              ? "border-[#CBE6D5] bg-[#F2FBF5] text-[#2F7A55]"
              : agent.status === "failed"
                ? "border-[#F0D5D2] bg-[#FDF6F5] text-[#B0443C]"
                : "border-[#D9E5FB] bg-[#F5F9FF] text-accent-strong"
          }`}
        >
          {STATUS_LABEL[agent.status]}
        </span>
        <span className="shrink-0 tabular-nums text-[10px] text-ink-faint">{formatDuration(duration)}</span>
        {running && (
          <button
            type="button"
            onClick={() => onStop(agent.id)}
            title="停止子 Agent"
            aria-label={`停止 ${agent.name}`}
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-ink-faint transition-colors hover:bg-[#FDF6F5] hover:text-[#B0443C]"
          >
            <Square size={8} strokeWidth={0} fill="currentColor" />
          </button>
        )}
      </div>

      <p className="mt-1 line-clamp-2 text-[10.5px] leading-4 text-ink-faint" title={agent.task}>
        {agent.task}
      </p>

      {tools && (
        <p className="mt-1 truncate font-mono text-[10px] text-ink-muted" title={tools}>
          {running ? "正在调用" : "已调用"} · {tools}
        </p>
      )}

      {agent.error && (
        <p className="mt-1 whitespace-pre-wrap break-words text-[10.5px] text-[#B0443C]">{agent.error}</p>
      )}

      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="mt-1 flex items-center gap-1 text-[10px] text-ink-faint transition-colors hover:text-ink"
      >
        <ChevronDown
          size={10}
          strokeWidth={2}
          className={`transition-transform duration-150 ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
        {open ? "收起输出" : `查看输出${agent.output ? `（${agent.output.split("\n").length} 行）` : ""}`}
      </button>
      {open && (
        <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-[#F7F8FA] px-2 py-1.5 font-mono text-[10px] leading-4 text-ink-soft">
          {agent.output || (running ? "子 Agent 正在思考…" : "（无输出）")}
        </pre>
      )}
    </div>
  );
}

/**
 * Right-panel "Agents" tab: live sub-agent list with status, duration, tools
 * and streamed output. Data comes from the Host via SSE; Next only proxies.
 */
export function SubagentPanel() {
  const [agents, setAgents] = useState<SubagentView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/subagents");
      const data = (await res.json()) as { agents?: SubagentView[]; error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setAgents(data.agents ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const source = new EventSource("/api/subagents/events");
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as { type?: string; agents?: SubagentView[] };
        if (data.type === "subagents" && data.agents) {
          setAgents(data.agents);
          setError(null);
        }
      } catch {
        /* ignore malformed frame */
      }
    };
    const fallback = setInterval(() => void load(), 10_000);
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      source.close();
      clearInterval(fallback);
      clearInterval(tick);
    };
  }, [load]);

  const handleStop = async (id: string) => {
    setStopping(id);
    try {
      await fetch("/api/subagents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop", id }),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStopping(null);
    }
  };

  if (error && agents.length === 0) {
    return <p className="px-3 py-2 text-[11px] text-danger">{error}</p>;
  }

  return (
    <div className="flex flex-col pt-1">
      {agents.length === 0 ? (
        <div className="px-3 py-3 text-[11px] text-ink-faint">
          <p className="flex items-center gap-1">
            <Bot size={12} strokeWidth={1.75} aria-hidden="true" />
            还没有子 Agent
          </p>
          <p className="mt-1 leading-5">
            当主 Agent 需要并行调研时，会用 <code className="font-mono text-[10.5px]">spawn_agent</code>{" "}
            派生独立的子 Agent；它们拥有自己的上下文和只读工具，输出会实时显示在这里。
          </p>
        </div>
      ) : (
        agents.map((agent) => (
          <SubagentCard key={agent.id} agent={agent} onStop={handleStop} now={now} />
        ))
      )}
      {stopping && (
        <p className="flex items-center gap-1 px-3 py-1 text-[10px] text-ink-faint">
          <Loader2 size={10} className="animate-spin" aria-hidden="true" /> 正在停止…
        </p>
      )}
    </div>
  );
}

export default SubagentPanel;
