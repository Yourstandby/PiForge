"use client";

/**
 * 右栏「Agents」：把子 Agent / 舰队 Agent 按 **项目 → 会话** 分组。
 *
 * 三条铁律：
 *   1. **归属可见**：每张卡片都写清 `项目 › 会话标题`，做完做不完一眼知道是谁的活；
 *   2. **零轮询**：数据全部来自 Host 已有的 SSE 广播（`/api/subagents/events`、
 *      `/api/fleet/events`），面板本身不发请求；SSE 断开时才回落一次快照；
 *   3. **低开销**：1 秒只驱动"耗时"这一个数字（行内 memo + 单一 tick），
 *      不做每秒整树重渲染。
 *
 * 完成事件通过 `onAgentDone` 上抛给 Workbench，复用右下角完成卡片。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AlertTriangle, Bot, CheckCircle2, ChevronRight, Loader2, Users } from "lucide-react";
import type { HerdrAgentView } from "@/contract/domains/herdr";
import type { SubagentView } from "@/contract/domains/subagents";
import {
  sessionTitleSnapshot,
  sessionTitlesVersion,
  subscribeSessionTitles,
} from "@/lib/session-titles";
import {
  groupAgentsForRail,
  isRunningStatus,
  type RailAgent,
  type RailAgentGroup,
  type RailAgentInput,
} from "@/lib/agent-rail";

/** 终态检测只需要这几个字段（子 Agent 与舰队 Agent 同形）。 */
interface TerminalCandidate {
  id: string;
  name: string;
  status: string;
  parentSessionId: string;
  cwd?: string;
}

export interface AgentRailDoneEvent {
  id: string;
  name: string;
  parentSessionId: string;
  cwd: string;
  status: string;
  verified: boolean;
  unverified: boolean;
}

interface Props {
  activeCwd: string | null;
  activeSessionId: string | null;
  /** 点击卡片：切到派生它的那个会话。 */
  onOpenSession: (sessionId: string) => void;
  /** 子 Agent 进入终态：交给 Workbench 弹完成卡片。 */
  onAgentDone?: (event: AgentRailDoneEvent) => void;
}

const STATUS_LABEL: Record<string, string> = {
  running: "运行中",
  starting: "启动中",
  stopping: "停止中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  stopped: "已停止",
  crashed: "崩溃",
};

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m${String(total % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function toRailInput(
  view: SubagentView | HerdrAgentView,
  kind: "subagent" | "fleet",
): RailAgentInput {
  const status = typeof (view as HerdrAgentView).activity === "string" &&
    kind === "fleet" &&
    (view as HerdrAgentView).status === "running"
    ? "running"
    : String(view.status);
  const verified = kind === "fleet"
    ? Boolean((view as HerdrAgentView).verified)
    : (view as SubagentView).verification?.verified;
  return {
    id: `${kind}:${view.id}`,
    kind,
    name: view.name,
    status,
    cwd: view.cwd,
    parentSessionId: view.parentSessionId,
    startedAt: view.startedAt,
    durationMs: view.durationMs,
    ...(verified === undefined ? {} : { verified }),
    ...(view.error ? { error: view.error } : {}),
  };
}

const AgentRow = memo(function AgentRow({
  agent,
  now,
  onOpenSession,
}: {
  agent: RailAgent;
  now: number;
  onOpenSession: (sessionId: string) => void;
}) {
  const end = agent.running ? now : agent.startedAt + agent.durationMs;
  const duration = formatDuration(end - agent.startedAt);
  return (
    <button
      type="button"
      onClick={() => onOpenSession(agent.parentSessionId)}
      title={`${agent.name} · ${STATUS_LABEL[agent.status] ?? agent.status}${agent.error ? ` · ${agent.error}` : ""}`}
      className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12px] text-[#374151] transition-colors hover:bg-[#E8EFFB]"
    >
      {agent.running ? (
        <Loader2 size={11} className="shrink-0 animate-spin text-[#2563EB]" strokeWidth={2.4} />
      ) : agent.status === "failed" || agent.status === "crashed" ? (
        <AlertTriangle size={11} className="shrink-0 text-[#DC2626]" strokeWidth={2.4} />
      ) : (
        <CheckCircle2 size={11} className="shrink-0 text-[#16A34A]" strokeWidth={2.4} />
      )}
      <span className="min-w-0 flex-1 truncate">{agent.name}</span>
      {agent.unverified && (
        <span
          title="没有测试/构建证据：结果未验证"
          className="shrink-0 rounded border border-[#FDE68A] bg-[#FFFBEB] px-1 text-[10px] leading-4 text-[#B45309]"
        >
          未验证
        </span>
      )}
      <span className="shrink-0 tabular-nums text-[11px] text-[#9CA3AF]">{duration}</span>
    </button>
  );
});

const GroupCard = memo(function GroupCard({
  group,
  now,
  onOpenSession,
}: {
  group: RailAgentGroup;
  now: number;
  onOpenSession: (sessionId: string) => void;
}) {
  const [open, setOpen] = useState(group.scope === "session");
  const badges = [group.running > 0 ? `${group.running} 运行` : null, group.failed > 0 ? `${group.failed} 失败` : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="rounded-lg border border-[#EDF1F7] bg-white">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left"
        title={`${group.cwd || "未知项目"} · ${group.sessionTitle}`}
      >
        <ChevronRight
          size={11}
          strokeWidth={2.4}
          className={`shrink-0 text-[#9CA3AF] transition-transform ${open ? "rotate-90" : ""}`}
        />
        {group.scope === "other" ? (
          <Users size={11} className="shrink-0 text-[#9CA3AF]" strokeWidth={2.2} />
        ) : (
          <Bot size={11} className="shrink-0 text-[#2563EB]" strokeWidth={2.2} />
        )}
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[#374151]">
          {group.projectName}
          <span className="text-[#9CA3AF]"> › </span>
          <span className="font-normal text-[#4B5563]">{group.sessionTitle}</span>
        </span>
        {badges && <span className="shrink-0 text-[10px] text-[#9CA3AF]">{badges}</span>}
      </button>
      {open && (
        <div className="pb-1">
          {group.agents.map((agent) => (
            <AgentRow key={agent.id} agent={agent} now={now} onOpenSession={onOpenSession} />
          ))}
        </div>
      )}
    </div>
  );
});

export function AgentRailPanel({
  activeCwd,
  activeSessionId,
  onOpenSession,
  onAgentDone,
}: Props) {
  const [subagents, setSubagents] = useState<SubagentView[]>([]);
  const [fleet, setFleet] = useState<HerdrAgentView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /** 会话标题来自侧栏登记的缓存（零额外请求）。 */
  const titlesVersion = useSyncExternalStore(subscribeSessionTitles, sessionTitlesVersion, () => 0);
  const terminalRef = useRef(new Map<string, string>());
  const doneRef = useRef(onAgentDone);
  doneRef.current = onAgentDone;

  /**
   * 终态检测：只有"见过它在跑"的 Agent 才算完成（面板中途打开时不会补发一堆旧卡片）。
   */
  const noteTerminal = useCallback(
    (views: readonly TerminalCandidate[], kind: "subagent" | "fleet") => {
      for (const view of views) {
        const key = `${kind}:${view.id}`;
        const status = String(view.status);
        const previous = terminalRef.current.get(key);
        terminalRef.current.set(key, status);
        if (isRunningStatus(status)) continue;
        if (!previous || !isRunningStatus(previous)) continue;
        const verified = kind === "fleet"
          ? Boolean((view as { verified?: boolean }).verified)
          : Boolean((view as { verification?: { verified?: boolean } }).verification?.verified);
        doneRef.current?.({
          id: key,
          name: view.name,
          parentSessionId: view.parentSessionId,
          cwd: view.cwd ?? "",
          status,
          verified,
          unverified: !verified,
        });
      }
    },
    [],
  );

  /** 子 Agent 广播：唯一的数据源（host 侧已做增量帧）。 */
  useEffect(() => {
    const source = new EventSource("/api/subagents/events");
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as { type?: string; agents?: SubagentView[] };
        if (data.type !== "subagents" || !data.agents) return;
        setSubagents(data.agents);
        noteTerminal(data.agents, "subagent");
        setError(null);
      } catch {
        /* malformed frame: ignore */
      }
    };
    source.onerror = () => setError("实时通道断开，正在重连…");
    return () => source.close();
  }, [noteTerminal]);

  /** 舰队广播：同样只吃推送。 */
  useEffect(() => {
    const source = new EventSource("/api/fleet/events");
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as { type?: string; agents?: HerdrAgentView[] };
        if (data.type !== "fleet" || !data.agents) return;
        setFleet(data.agents);
        noteTerminal(data.agents, "fleet");
      } catch {
        /* ignore */
      }
    };
    return () => source.close();
  }, [noteTerminal]);

  /**
   * 1 秒只更新"现在"，行内用 memo 挡住整树重渲染。
   * 只在真的有运行中的 agent 时才跳秒表（0.9.0 是常驻 1s 定时器：空闲时也在叫醒渲染进程）；
   * 窗口隐藏时直接停。
   */
  const hasRunningAgent = useMemo(() => {
    const agents = [
      ...subagents.map((view) => toRailInput(view, "subagent")),
      ...fleet.map((view) => toRailInput(view, "fleet")),
    ];
    return agents.some((agent) => isRunningStatus(agent.status));
  }, [subagents, fleet]);

  useEffect(() => {
    if (!hasRunningAgent) return;
    const tick = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      setNow(Date.now());
    }, 1_000);
    return () => clearInterval(tick);
  }, [hasRunningAgent]);

  // titlesVersion 是订阅信号：缓存内容变了它就变，用它当 memo 的钥匙。
  const sessionTitleById = useMemo(
    () => sessionTitleSnapshot(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [titlesVersion],
  );

  const { groups, hiddenGroups, running, unverified } = useMemo(() => {
    const agents = [
      ...subagents.map((view) => toRailInput(view, "subagent")),
      ...fleet.map((view) => toRailInput(view, "fleet")),
    ];
    return groupAgentsForRail(agents, {
      activeCwd,
      activeSessionId,
      sessionTitleById,
    });
  }, [subagents, fleet, activeCwd, activeSessionId, sessionTitleById]);

  const summary = [
    running > 0 ? `${running} 运行中` : null,
    unverified > 0 ? `${unverified} 未验证` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-[#6B7280]">
        <span className="font-medium text-[#374151]">Agents</span>
        <span className="text-[#9CA3AF]">{summary || "本会话暂无子 Agent"}</span>
        {error && <span className="ml-auto truncate text-[#B45309]">{error}</span>}
      </div>
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-2 pb-2">
        {groups.length === 0 && (
          <p className="px-1 py-3 text-[11px] leading-5 text-[#9CA3AF]">
            让 Agent 派生一个子任务（`spawn_agent` / `herdr_spawn`），这里会按
            <span className="text-[#6B7280]"> 项目 › 会话 </span>
            分组显示进度；完成后会弹右下角卡片，点一下直接切到那个对话。
          </p>
        )}
        {groups.map((group) => (
          <GroupCard key={group.key} group={group} now={now} onOpenSession={onOpenSession} />
        ))}
        {hiddenGroups > 0 && (
          <p className="px-1 text-[10px] text-[#9CA3AF]">另有 {hiddenGroups} 个更早的会话分组已折叠</p>
        )}
      </div>
    </div>
  );
}
