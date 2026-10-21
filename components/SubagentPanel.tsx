"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  ChevronDown,
  Loader2,
  Plus,
  Send,
  Square,
  Trash2,
  Zap,
} from "lucide-react";
import type { SubagentStatus, SubagentView } from "@contract/domains/subagents";
import type { HerdrAgentView } from "@contract/domains/herdr";
import type { FleetAgentProfile } from "@contract/domains/fleet";
import { mergeSubagentFrame, sortSubagents } from "@/lib/subagent-view";
import {
  fleetStatusLabel,
  pairFleetRows,
  sortFleetRows,
  type FleetRow,
} from "@/lib/fleet-view";
import { ErrorNotice } from "./ErrorNotice";
import { FleetAgentModal } from "./FleetAgentModal";

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
  const unverified = agent.status === "completed" && agent.verification?.verified === false;
  const verificationTitle = agent.verification
    ? `${agent.verification.reason}${agent.verification.evidence.length > 0 ? `\n${agent.verification.evidence.join("\n")}` : ""}`
    : undefined;

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
        {unverified && (
          <span
            title={verificationTitle}
            className="shrink-0 rounded-full border border-[#F0E0C2] bg-[#FFF9EE] px-1.5 py-0.5 text-[9.5px] font-medium text-[#9A6B1F]"
          >
            未验证
          </span>
        )}
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

      {!running && agent.verification && (
        <p
          className={`mt-1 text-[10px] ${unverified ? "text-[#9A6B1F]" : "text-[#2F7A55]"}`}
          title={verificationTitle}
        >
          {agent.verification.verified ? "已验证：找到测试/构建证据" : `未验证：${agent.verification.reason}`}
        </p>
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

/** 舰队 Agent（常驻待命）：可直接选中并下发消息（底层 herdr_message）。 */
function FleetCard({
  row,
  now,
  busy,
  onWake,
  onSleep,
  onDelete,
  onEdit,
  onSend,
}: {
  row: FleetRow;
  now: number;
  busy: boolean;
  onWake: (profile: FleetAgentProfile) => void;
  onSleep: (agentId: string) => void;
  onDelete: (profile: FleetAgentProfile) => void;
  onEdit: (profile: FleetAgentProfile) => void;
  onSend: (agentId: string, message: string) => Promise<void>;
}) {
  const agent = row.agent;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const live = Boolean(agent) && agent?.status === "running";
  const status = fleetStatusLabel(agent);
  const duration = agent
    ? agent.endedAt
      ? agent.durationMs
      : Math.max(0, now - agent.startedAt)
    : 0;
  const turns = agent?.turns ?? 0;
  const exhausted = turns >= 3;

  const submit = async () => {
    const message = draft.trim();
    if (!agent || !message || sending) return;
    setSending(true);
    try {
      await onSend(agent.id, message);
      setDraft("");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mx-1.5 mb-1.5 rounded-lg border border-[#DDE6F5] bg-[#FBFCFF] px-2.5 py-2 shadow-[0_1px_2px_rgba(17,17,17,0.03)]">
      <div className="flex items-center gap-1.5">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${live && agent?.activity === "working" ? "animate-pulse" : ""}`}
          style={{ background: live ? "#2563EB" : "#C9CFDA" }}
          aria-hidden="true"
        />
        <span className="shrink-0 rounded border border-[#D9E5FB] bg-[#F1F6FF] px-1 py-px text-[9px] font-medium text-accent-strong">
          舰队
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink" title={row.profile.systemPrompt}>
          {row.profile.name}
        </span>
        <span
          className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[9.5px] font-medium ${
            agent?.error
              ? "border-[#F0D5D2] bg-[#FDF6F5] text-[#B0443C]"
              : live
                ? "border-[#CBE6D5] bg-[#F2FBF5] text-[#2F7A55]"
                : "border-[#E3E6EC] bg-[#F7F8FA] text-ink-faint"
          }`}
        >
          {status}
        </span>
        {agent && (
          <span className="shrink-0 tabular-nums text-[10px] text-ink-faint">{formatDuration(duration)}</span>
        )}
      </div>

      <p className="mt-1 line-clamp-2 text-[10.5px] leading-4 text-ink-faint" title={row.profile.systemPrompt}>
        {agent?.task?.trim() || row.profile.systemPrompt.split("\n")[0]}
      </p>

      <div className="mt-1 flex items-center gap-1.5 text-[10px] text-ink-faint">
        <span className="truncate font-mono">
          {row.profile.tools.length > 0 ? row.profile.tools.join(" · ") : "只读工具"}
        </span>
        {agent && (
          <span className={`ml-auto shrink-0 ${exhausted ? "text-[#B0443C]" : ""}`}>
            {turns}/3 轮
          </span>
        )}
      </div>

      {agent?.error && (
        <p className="mt-1 whitespace-pre-wrap break-words text-[10.5px] text-[#B0443C]">{agent.error}</p>
      )}

      <div className="mt-1.5 flex items-center gap-1">
        {!live ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => onWake(row.profile)}
            className="flex items-center gap-1 rounded-md border border-[#D9E5FB] bg-white px-1.5 py-0.5 text-[10.5px] text-accent-strong transition-colors hover:bg-[#F1F6FF] disabled:opacity-40"
          >
            <Zap size={10} strokeWidth={2} aria-hidden="true" />
            {agent ? "重新唤醒" : "唤醒"}
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => onSleep(agent!.id)}
            title="停止这个舰队 Agent（配置保留，可再唤醒）"
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] text-ink-faint transition-colors hover:bg-[#FDF6F5] hover:text-[#B0443C] disabled:opacity-40"
          >
            <Square size={9} strokeWidth={0} fill="currentColor" aria-hidden="true" />
            休眠
          </button>
        )}
        <button
          type="button"
          onClick={() => onEdit(row.profile)}
          className="rounded-md px-1.5 py-0.5 text-[10.5px] text-ink-faint transition-colors hover:bg-[#F1F3F7] hover:text-ink"
        >
          编辑
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onDelete(row.profile)}
          title="删除常驻配置"
          className="ml-auto flex h-4 w-4 items-center justify-center rounded text-ink-faint transition-colors hover:bg-[#FDF6F5] hover:text-[#B0443C] disabled:opacity-40"
        >
          <Trash2 size={10} strokeWidth={1.9} aria-hidden="true" />
        </button>
      </div>

      {live && (
        <div className="mt-1.5">
          <div className="flex items-end gap-1">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submit();
                }
              }}
              rows={2}
              disabled={exhausted}
              placeholder={exhausted ? "已达 3 轮上限，请新建一个舰队 Agent" : "给这个舰队 Agent 下达指令…"}
              className="min-h-[38px] w-full resize-y rounded-md border border-[#E3E6EC] px-1.5 py-1 text-[11px] leading-4 text-ink outline-none transition-colors focus:border-accent/50 focus:ring-2 focus:ring-accent/15 disabled:bg-[#F7F8FA] disabled:text-ink-faint"
            />
            <button
              type="button"
              disabled={sending || exhausted || !draft.trim()}
              onClick={() => void submit()}
              aria-label="发送"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30"
            >
              {sending ? (
                <Loader2 size={11} className="animate-spin" aria-hidden="true" />
              ) : (
                <Send size={11} strokeWidth={2} aria-hidden="true" />
              )}
            </button>
          </div>
        </div>
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
        {open ? "收起输出" : `查看输出${agent?.output ? `（${agent.output.split("\n").length} 行）` : ""}`}
      </button>
      {open && (
        <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-[#F7F8FA] px-2 py-1.5 font-mono text-[10px] leading-4 text-ink-soft">
          {agent?.output || (live ? "舰队 Agent 待命中…" : "（无输出）")}
        </pre>
      )}
    </div>
  );
}

/**
 * Right-panel "Agents" tab.
 *
 * 两条数据链，都是 Host 推送（SSE）：
 *   - `/api/subagents/events`：临时子 Agent（spawn_agent，用完即销毁）；
 *   - `/api/fleet/events`：常驻舰队 Agent（herdr_spawn / 手建配置）。
 * 配置（名字 / System Prompt / 工具权限）持久化在 Host 的 `fleet/agents.json`。
 */
/**
 * `sessionId` 用来把「本会话派生的临时子 Agent」排在前面（不过滤掉别的会话，
 * 否则一旦 id 口径不一致就会出现"明明是它派生的却看不到"）；
 * `cwd` 让手动唤醒的舰队 Agent 落在正确的项目目录。
 */
export function SubagentPanel({
  sessionId,
  cwd,
}: {
  sessionId?: string | null;
  cwd?: string | null;
} = {}) {
  const [agents, setAgents] = useState<SubagentView[]>([]);
  const [fleetAgents, setFleetAgents] = useState<HerdrAgentView[]>([]);
  const [profiles, setProfiles] = useState<FleetAgentProfile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [live, setLive] = useState(false);
  const liveRef = useRef(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<FleetAgentProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  const loadSubagents = useCallback(async () => {
    try {
      const res = await fetch("/api/subagents");
      const data = (await res.json()) as { agents?: SubagentView[]; error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setAgents(sortSubagents(data.agents ?? []));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const loadFleet = useCallback(async () => {
    try {
      const res = await fetch("/api/fleet", { cache: "no-store" });
      const data = (await res.json()) as {
        profiles?: FleetAgentProfile[];
        agents?: HerdrAgentView[];
        error?: string;
      };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setProfiles(data.profiles ?? []);
      setFleetAgents(data.agents ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const reload = useCallback(async () => {
    await Promise.all([loadSubagents(), loadFleet()]);
  }, [loadSubagents, loadFleet]);

  /* ------------------------------- SSE：子 Agent ------------------------------- */
  useEffect(() => {
    void reload();
    const source = new EventSource("/api/subagents/events");
    const setLiveState = (value: boolean) => {
      liveRef.current = value;
      setLive(value);
    };
    source.onopen = () => setLiveState(true);
    source.onerror = () => setLiveState(false);
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as {
          type?: string;
          agents?: SubagentView[];
          events?: Parameters<typeof mergeSubagentFrame>[1]["events"];
        };
        if (data.type !== "subagents") return;
        setLiveState(true);
        setAgents((prev) => mergeSubagentFrame(prev, data));
        setError(null);
      } catch {
        /* ignore malformed frame */
      }
    };
    const fallback = setInterval(() => {
      if (!liveRef.current) void loadSubagents();
    }, 5_000);
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      source.close();
      clearInterval(fallback);
      clearInterval(tick);
    };
  }, [reload, loadSubagents]);

  /* -------------------------------- SSE：舰队 -------------------------------- */
  useEffect(() => {
    const source = new EventSource("/api/fleet/events");
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as { type?: string; agents?: HerdrAgentView[] };
        if (data.type !== "fleet" || !data.agents) return;
        setFleetAgents(data.agents);
      } catch {
        /* ignore malformed frame */
      }
    };
    return () => source.close();
  }, []);

  /** 面板 / 窗口重新可见时立即刷新（不用等轮询）。 */
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") void reload();
    };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [reload]);

  const fleetRows = useMemo(
    () => sortFleetRows(pairFleetRows(profiles, fleetAgents)),
    [profiles, fleetAgents],
  );
  /**
   * 本会话派生的子 Agent 优先展示。
   *
   * 这里**不做过滤**：桌面会话 id 与 pi 内部 sessionId 口径不一定一致，
   * 一旦对不上，过滤会让面板直接空白（"明明在跑却看不到"）。排序同样满足
   * "当前的排最前"，但永远不会漏掉任何一条。
   */
  const scopedAgents = useMemo(() => {
    if (!sessionId) return agents;
    return [...agents].sort((a, b) => {
      const mine = Number(b.parentSessionId === sessionId) - Number(a.parentSessionId === sessionId);
      if (mine !== 0) return mine;
      return b.startedAt - a.startedAt;
    });
  }, [agents, sessionId]);
  const liveSubagents = useMemo(
    () => scopedAgents.filter((agent) => agent.status === "running"),
    [scopedAgents],
  );
  const finishedSubagents = useMemo(
    () => scopedAgents.filter((agent) => agent.status !== "running"),
    [scopedAgents],
  );

  const postFleet = useCallback(
    async (body: Record<string, unknown>) => {
      const res = await fetch("/api/fleet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      return data;
    },
    [],
  );

  const handleStop = async (id: string) => {
    setStopping(id);
    try {
      await fetch("/api/subagents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop", id }),
      });
      await loadSubagents();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStopping(null);
    }
  };

  const handleSave = async (draft: {
    id?: string;
    name: string;
    systemPrompt: string;
    tools: string[];
    persistent: boolean;
  }) => {
    setBusy(true);
    setModalError(null);
    try {
      const saved = (await postFleet({ action: "save", profile: draft })) as {
        profile?: FleetAgentProfile;
      };
      if (draft.persistent && saved.profile) {
        await postFleet({
          action: "wake",
          id: saved.profile.id,
          ...(cwd ? { cwd } : {}),
          ...(sessionId ? { parentSessionId: sessionId } : {}),
        });
      }
      await loadFleet();
      setModalOpen(false);
      setEditing(null);
    } catch (e) {
      setModalError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleImport = async (payload: unknown) => {
    setBusy(true);
    setModalError(null);
    try {
      await postFleet({ action: "import", payload });
      await loadFleet();
      setModalOpen(false);
    } catch (e) {
      setModalError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleWake = async (profile: FleetAgentProfile) => {
    setBusy(true);
    try {
      await postFleet({
        action: "wake",
        id: profile.id,
        ...(cwd ? { cwd } : {}),
        ...(sessionId ? { parentSessionId: sessionId } : {}),
      });
      await loadFleet();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleSleep = async (agentId: string) => {
    setBusy(true);
    try {
      await postFleet({ action: "stop", id: agentId });
      await loadFleet();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (profile: FleetAgentProfile) => {
    setBusy(true);
    try {
      await postFleet({ action: "delete", id: profile.id });
      await loadFleet();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleFleetMessage = async (agentId: string, message: string) => {
    setError(null);
    try {
      await postFleet({ action: "message", id: agentId, message });
      await loadFleet();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const empty = scopedAgents.length === 0 && fleetRows.length === 0;

  if (error && empty) {
    return (
      <ErrorNotice
        message={error}
        className="block px-3 py-2 text-[11px] text-danger"
        fallback={<span className="block px-3 py-2 text-[11px] text-ink-faint">正在等待本地引擎就绪…</span>}
      />
    );
  }

  return (
    <div className="flex flex-col pt-1">
      <div className="mx-1.5 mb-1.5 flex items-center gap-1.5">
        <span className="text-[10px] uppercase tracking-[0.08em] text-ink-faint">Agents</span>
        {!live && agents.length > 0 && (
          <span className="text-[10px] text-ink-faint">· 实时推送已断开</span>
        )}
        <button
          type="button"
          onClick={() => {
            setEditing(null);
            setModalError(null);
            setModalOpen(true);
          }}
          className="ml-auto flex items-center gap-1 rounded-md border border-[#D9E5FB] bg-white px-1.5 py-0.5 text-[10.5px] font-medium text-accent-strong transition-colors hover:bg-[#F1F6FF]"
        >
          <Plus size={11} strokeWidth={2.2} aria-hidden="true" />
          新建 / 加载 Agent
        </button>
      </div>

      {error && (
        <p className="mx-1.5 mb-1 text-[10.5px] text-[#B0443C]">{error}</p>
      )}

      {fleetRows.length > 0 && (
        <section className="mb-1">
          <h3 className="mx-1.5 mb-1 flex items-center gap-1 text-[10px] uppercase tracking-[0.08em] text-ink-faint">
            舰队 Agent · 常驻
            <span className="rounded bg-[#F1F6FF] px-1 text-[9px] text-accent-strong">
              {fleetRows.filter((row) => row.dormant).length} 待唤醒 / {fleetRows.length} 常驻
            </span>
          </h3>
          {fleetRows.map((row) => (
            <FleetCard
              key={row.profile.id}
              row={row}
              now={now}
              busy={busy}
              onWake={handleWake}
              onSleep={handleSleep}
              onDelete={handleDelete}
              onEdit={(profile) => {
                setEditing(profile);
                setModalError(null);
                setModalOpen(true);
              }}
              onSend={handleFleetMessage}
            />
          ))}
        </section>
      )}

      {liveSubagents.length > 0 && (
        <section className="mb-1">
          <h3 className="mx-1.5 mb-1 text-[10px] uppercase tracking-[0.08em] text-ink-faint">
            临时子 Agent · 运行中
          </h3>
          {liveSubagents.map((agent) => (
            <SubagentCard key={agent.id} agent={agent} onStop={handleStop} now={now} />
          ))}
        </section>
      )}

      {finishedSubagents.length > 0 && (
        <section className="mb-1">
          <h3 className="mx-1.5 mb-1 text-[10px] uppercase tracking-[0.08em] text-ink-faint">
            临时子 Agent · 已完成
          </h3>
          {finishedSubagents.map((agent) => (
            <SubagentCard key={agent.id} agent={agent} onStop={handleStop} now={now} />
          ))}
        </section>
      )}

      {empty && (
        <div className="px-3 py-3 text-[11px] text-ink-faint">
          <p className="flex items-center gap-1">
            <Bot size={12} strokeWidth={1.75} aria-hidden="true" />
            还没有 Agent
          </p>
          <p className="mt-1 leading-5">
            临时子 Agent 由主 Agent 用{" "}
            <code className="font-mono text-[10.5px]">spawn_agent</code> 派生（用完即销毁）；
            舰队 Agent 用右上角「新建 / 加载 Agent」手动派驻，常驻待命、可反复下发消息。
          </p>
          <p className="mt-1 leading-5 text-[10.5px]">
            省钱阀门：每个 Agent 最多 3 轮对话，回给主 Agent 的只有摘要，单轮上下文超 10k
            tokens 会自动熔断。
          </p>
        </div>
      )}

      {stopping && (
        <p className="flex items-center gap-1 px-3 py-1 text-[10px] text-ink-faint">
          <Loader2 size={10} className="animate-spin" aria-hidden="true" /> 正在停止…
        </p>
      )}

      <FleetAgentModal
        open={modalOpen}
        initial={editing}
        busy={busy}
        error={modalError}
        onClose={() => {
          setModalOpen(false);
          setEditing(null);
        }}
        onSave={(draft) => void handleSave(draft)}
        onImport={(payload) => void handleImport(payload)}
      />
    </div>
  );
}

export default SubagentPanel;
