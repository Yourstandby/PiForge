"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  Hand,
  MessageCircleQuestion,
  Radar,
  ScanSearch,
  SkipForward,
  Timer,
  TriangleAlert,
} from "lucide-react";
import {
  STALL_MS_PRESETS,
  configureStallMs,
  readStoredStallMs,
  refreshWatchdog,
  requestIntervention,
  useTicker,
  useWatchdogNotice,
  useWatchdogStore,
  useWatchdogTask,
} from "@/hooks/useWatchdogStatus";
import type {
  InterventionActionType,
  WatchdogAwaiting,
  WatchdogVerdictDecision,
} from "@/contract/domains/watchdog";
import { WatchdogDot } from "./StatusDot";
import {
  formatIdleSeconds,
  livenessSeconds,
  panelLight,
  stallMsOf,
  toolSummary,
} from "@/lib/watchdog-view";

/**
 * 右侧「系统监控」面板（WatchdogPanel）。
 *
 * 状态隔离（关键设计，改动前先读）：
 *   - 本面板是看门狗快照的**唯一重订阅者**（加上左栏状态灯/工具行图标这两个极小的叶子）；
 *   - 快照来自模块级单例轮询（`hooks/useWatchdogStatus.ts`），
 *     `ChatSurface` 一行都不订阅，也**不向下传任何 watchdog prop**，
 *     所以看门狗的任何刷新都不可能触发主聊天流重渲染；
 *   - 每秒跳动的「最后活动」用本组件内的本地时钟（`useTicker`）驱动，
 *     连 store 都不会被通知 —— 纯 CPU 上的一个 number 更新；
 *   - 面板自身只在「状态 / 最后活动时间 / 通知数」变化时重渲染。
 *
 * 介入动作（Skip / Ask）走 `POST /api/agent/[id]/intervene` → Host
 * `agent.intervene`：注入既有 steer / prompt / follow-up 队列，并立刻把
 * 看门狗状态重置回 running。全程没有新增的模型直连。
 */

type LogKind = "info" | "ok" | "error";

interface PanelLogEntry {
  id: number;
  at: number;
  kind: LogKind;
  text: string;
}

const ACTIVE = new Set(["running", "stalled"]);

export function WatchdogPanel({ sessionId }: { sessionId: string | null }) {
  const state = useWatchdogStore();
  const task = useWatchdogTask(sessionId);
  const notice = useWatchdogNotice(sessionId, task?.taskId ?? null);
  const active = Boolean(task && ACTIVE.has(task.status));
  const now = useTicker(active);
  const stallMs = stallMsOf(state);

  // 挂载即主动拉一次：轮询若曾因为旧 Host 失败而退让，打开面板就能恢复。
  useEffect(() => {
    refreshWatchdog();
  }, [sessionId]);

  const [pending, setPending] = useState<InterventionActionType | null>(null);
  const [logs, setLogs] = useState<PanelLogEntry[]>([]);
  const logSeq = useRef(0);
  const [jsonOpen, setJsonOpen] = useState(false);
  /** 阈值下拉框的本地值：先乐观更新，失败后由快照拉回真实值。 */
  const [stallDraft, setStallDraft] = useState(stallMs);
  const [savingStall, setSavingStall] = useState(false);
  /** 最近一次介入后「等待状态恢复」的锁：直到任务重新有进展 / 重新卡住 / 超时才解锁。 */
  const [awaitingRecovery, setAwaitingRecovery] = useState(false);
  /** 介入刚发出时记住的活动时间；观察到更新的活动 = 模型真的继续跑了。 */
  const sentAtActivity = useRef<number | null>(null);
  /** 介入后最多锁这么久：模型真没动也能再试一次（否则按钮会永久置灰）。 */
  const RECOVERY_LOCK_MS = 8_000;

  useEffect(() => {
    if (!awaitingRecovery) return;
    const finish = () => {
      setAwaitingRecovery(false);
      sentAtActivity.current = null;
    };
    const base = sentAtActivity.current;
    if (!task) return finish();
    // 已经有新活动 / 已经跑完 / 又重新卡住（允许二次介入，仍受冷却与次数上限约束）。
    if (base === null || task.lastActivityAt > base || task.status !== "running") return finish();
    const timer = window.setTimeout(finish, RECOVERY_LOCK_MS);
    return () => window.clearTimeout(timer);
  }, [awaitingRecovery, task]);

  const pushLog = useCallback((kind: LogKind, text: string) => {
    logSeq.current += 1;
    const entry: PanelLogEntry = { id: logSeq.current, at: Date.now(), kind, text };
    setLogs((previous) => [entry, ...previous].slice(0, 12));
  }, []);

  // 快照是唯一真相：Host 回报什么就显示什么（乐观更新后会被它覆盖）。
  useEffect(() => {
    setStallDraft(stallMs);
  }, [stallMs]);

  /**
   * 挂载后把上次选的阈值回写到 Host（Host 重启会回落到 env/默认值）。
   * 只在「快照已就绪 + 与本地记录不一致」时发一次，失败不重试（快照不变，不会循环）。
   */
  useEffect(() => {
    if (!state.ready || !state.enabled) return;
    const stored = readStoredStallMs();
    if (stored === null || stored === state.config?.stallMs) return;
    void configureStallMs(stored);
  }, [state.ready, state.enabled, state.config?.stallMs]);

  const changeStallMs = useCallback(
    async (next: number) => {
      const previous = stallDraft;
      setStallDraft(next);
      setSavingStall(true);
      const res = await configureStallMs(next);
      setSavingStall(false);
      if (res.ok) {
        pushLog("ok", `停滞阈值已切到 ${Math.round(next / 1000)} 秒`);
        return;
      }
      setStallDraft(previous);
      pushLog("error", `阈值切换失败：${res.error ?? "未知错误"}`);
    },
    [pushLog, stallDraft],
  );

  /** 心跳（活着的迹象）：工具启动 / 流式输出都会刷。 */
  const liveSeconds = livenessSeconds(task, now);
  /** 无进展（有效进展计时）：并发工具全部沉默时它才会增长。 */
  const idleSeconds = task ? Math.max(0, task.idleSeconds, Math.round((now - task.lastActivityAt) / 1000)) : 0;
  const tools = task?.tools ?? [];
  const toolLabel = toolSummary(task);
  const stalled = task?.status === "stalled" || task?.status === "failed";
  const ratio = task ? Math.min(1, (idleSeconds * 1000) / stallMs) : 0;

  const send = useCallback(
    async (actionType: InterventionActionType) => {
      if (!sessionId || pending) return;
      setPending(actionType);
      pushLog(
        "info",
        actionType === "skip"
          ? "正在发送跳过指令…"
          : actionType === "ask_brief"
            ? "正在发送极简询问（禁工具、限一句）…"
            : "正在发送深度诊断（可能触发工具调用）…",
      );
      try {
        const outcome = await requestIntervention(sessionId, actionType);
        if (outcome.ok) {
          sentAtActivity.current = outcome.task?.lastActivityAt ?? Date.now();
          setAwaitingRecovery(true);
          pushLog("ok", outcome.detail ?? "指令已发送，看门狗计时已重置");
        } else {
          pushLog("error", outcome.detail ?? "介入被拒绝");
        }
      } catch (error) {
        pushLog("error", error instanceof Error ? error.message : String(error));
      } finally {
        setPending(null);
      }
    },
    [pending, pushLog, sessionId],
  );

  const light = useMemo(() => panelLight(sessionId, task), [sessionId, task]);

  // 不再要求 `stalled`：任务还在跑也要能人工介入，否则得先等 25s 判卡顿。
  const disabled = pending !== null || awaitingRecovery || !task;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <header className="flex items-center gap-2 border-b border-[#EDF1F7] px-3 py-2">
        <Radar size={14} strokeWidth={2} className="shrink-0 text-accent-strong" aria-hidden="true" />
        <span className="text-[12.5px] font-medium text-ink">系统监控</span>
        <span className="ml-auto text-[10px] text-ink-faint">本地状态 · 不产生模型调用</span>
      </header>

      {/* ---- 结论条：不点按钮就能拿到「该不该介入」 ---- */}
      {task && (
        <section
          aria-live="polite"
          className={`border-b border-[#EDF1F7] px-3 py-2 ${verdictSurface(task.verdict.decision)}`}
        >
          <div className="flex items-start gap-1.5">
            <span aria-hidden="true" className="mt-[3px] shrink-0">
              {verdictIcon(task.verdict.decision)}
            </span>
            <div className="min-w-0">
              <p className="text-[11.5px] font-medium leading-snug text-ink">{task.verdict.headline}</p>
              <p className="mt-0.5 text-[10px] text-ink-faint">
                {awaitingLabel(task.awaiting)}
                {verdictHint(task.verdict.decision)}
              </p>
            </div>
          </div>
          {task.verdict.evidence.length > 0 && (
            <ul className="mt-1 space-y-0.5 pl-5 text-[10px] leading-relaxed text-ink-muted">
              {task.verdict.evidence.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* ---- 上半部分：实时心跳 ---- */}
      <section className="border-b border-[#EDF1F7] px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className={`h-2 w-2 shrink-0 rounded-full ${lightToneClass(light.tone)}`}
          />
          <span className="text-[12px] text-ink">{light.label}</span>
          {task && (
            <span className="ml-auto font-mono text-[10px] tabular-nums text-ink-faint">
              {Math.round(ratio * 100)}% 阈值
            </span>
          )}
        </div>

        {/* 阈值下拉框：运行期调 Host 的 stallMs，不重启、不重建定时器。 */}
        <div className="mt-2 flex items-center gap-1.5">
          <label htmlFor="watchdog-stall-ms" className="shrink-0 text-[10.5px] text-ink-faint">
            停滞阈值
          </label>
          <select
            id="watchdog-stall-ms"
            aria-label="停滞阈值"
            value={stallDraft}
            disabled={!state.enabled || savingStall}
            onChange={(event) => void changeStallMs(Number(event.target.value))}
            className="ml-auto rounded-md border border-[#E2E8F2] bg-white px-1.5 py-0.5 text-[11px] text-ink outline-none transition-colors hover:border-[#CBD5E6] focus:border-[#93B4F0] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {!(STALL_MS_PRESETS as readonly number[]).includes(stallDraft) && (
              <option value={stallDraft}>{Math.round(stallDraft / 1000)} 秒（当前）</option>
            )}
            {STALL_MS_PRESETS.map((preset) => (
              <option key={preset} value={preset}>
                {Math.round(preset / 1000)} 秒
              </option>
            ))}
          </select>
          {savingStall && <span className="text-[10px] text-ink-faint">切换中…</span>}
        </div>

        {task && (
          <dl className="mt-2 space-y-1 text-[11px]">
            {toolLabel && (
              <Row
                label="并发"
                value={`${toolLabel}${task.toolIdleSeconds > 0 ? ` · 最久 ${task.toolIdleSeconds}s 无输出` : ""}`}
                tone={tools.some((tool) => tool.overThreshold) ? "danger" : "default"}
              />
            )}
            <Row label="最后活动" value={`${formatIdleSeconds(liveSeconds)}`} mono />
            <Row
              label="连续无进展"
              value={`${idleSeconds} 秒 / ${Math.round(stallMs / 1000)} 秒`}
              mono
              tone={stalled ? "danger" : ratio >= 0.7 ? "warn" : "default"}
            />
            <Row label="已完成步骤" value={`${task.completedSteps} 步`} />
            <Row label="最后成功动作" value={task.lastSuccessAction ?? "—"} />
            {tools.length === 0 && task.pendingTool && <Row label="执行中的工具" value={task.pendingTool} />}
          </dl>
        )}

        {tools.length > 0 && (
          <ul className="mt-2 space-y-0.5">
            {tools.map((tool) => (
              <li
                key={tool.toolCallId}
                className="flex items-center gap-1.5 rounded px-1 py-0.5 text-[10.5px] odd:bg-[#F7F9FC]"
              >
                <span
                  aria-hidden="true"
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    tool.overThreshold ? "bg-[#C2554E]" : "bg-[#34c38f] animate-pulse"
                  }`}
                />
                <span className="min-w-0 flex-1 truncate font-mono text-ink-muted">{tool.name}</span>
                <span className="shrink-0 font-mono tabular-nums text-ink-faint">
                  {tool.runningSeconds}s
                </span>
                <span
                  className={`shrink-0 font-mono tabular-nums ${
                    tool.overThreshold ? "text-[#B0443C]" : "text-ink-faint"
                  }`}
                  title={tool.hasOutput ? "距上次输出" : "尚无任何输出"}
                >
                  {tool.idleSeconds}s 无输出
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---- 下半部分：诊断与介入 ---- */}
      <section className={`px-3 py-2.5 ${stalled ? "bg-[#FDF2F2]" : ""}`}>
        <div className="flex items-center gap-1.5">
          <TriangleAlert
            size={12}
            strokeWidth={2.2}
            className={stalled ? "text-[#C2554E]" : "text-ink-faint"}
            aria-hidden="true"
          />
          <span className={`text-[11.5px] font-medium ${stalled ? "text-[#B0443C]" : "text-ink-muted"}`}>
            诊断与介入
          </span>
          {stalled && (
            <span className="rounded-full border border-[#F0D5D2] bg-white px-1.5 py-0.5 text-[9.5px] font-medium text-[#B0443C]">
              红灯
            </span>
          )}
        </div>

        {stalled && task ? (
          <div className="mt-1.5 space-y-1 text-[11px] text-[#8C3B36]">
            <p>
              <span className="text-ink-faint">最后成功动作：</span>
              {task.lastSuccessAction ?? "无"}
            </p>
            <p className="break-words">
              <span className="text-ink-faint">疑似阻塞点：</span>
              {task.suspectedBlocker}
            </p>
            <p className="text-[10.5px] text-ink-faint">
              尝试 {task.attempts} 次 · 失败 {task.failedAttempts} 次 · 重复 {task.duplicateAttempts} 次
            </p>
          </div>
        ) : (
          <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
            {task
              ? "任务有进展时这里保持静默；长时间无进展会亮红灯，介入按钮随时可用。"
              : "选择一个会话后即可查看它的执行心跳。"}
          </p>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <InterventionButton
            icon={<SkipForward size={12} strokeWidth={2} aria-hidden="true" />}
            label={pending === "skip" ? "发送中…" : "强制跳过 (Skip)"}
            onClick={() => void send("skip")}
            disabled={disabled}
            tone="primary"
          />
          <InterventionButton
            icon={<MessageCircleQuestion size={12} strokeWidth={2} aria-hidden="true" />}
            label={pending === "ask_brief" ? "发送中…" : "极简询问"}
            onClick={() => void send("ask_brief")}
            disabled={disabled}
            tone="ghost"
            hint="禁止模型跑工具核实，只回一句话（20 字内），几乎不消耗 Token"
          />
          <InterventionButton
            icon={<ScanSearch size={12} strokeWidth={2} aria-hidden="true" />}
            label={pending === "ask" ? "发送中…" : "深度诊断"}
            onClick={() => void send("ask")}
            disabled={disabled || task?.verdict.decision !== "intervene"}
            tone="ghost"
            hint="允许模型重新查状态，回复更长、消耗更多 Token；只有结论是「该介入」时才需要"
          />
          {awaitingRecovery && (
            <span className="text-[10px] text-ink-faint">等待模型恢复输出…</span>
          )}
        </div>
        {!stalled && (
          <p className="mt-1 text-[10px] text-ink-faint">
            任务进行中也可随时介入（同任务 3s 冷却、最多 5 次）。
          </p>
        )}

        {notice && (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setJsonOpen((open) => !open)}
              aria-expanded={jsonOpen}
              className="flex items-center gap-1 text-[10.5px] text-ink-muted transition-colors hover:text-ink"
            >
              <ChevronDown
                size={11}
                strokeWidth={2}
                aria-hidden="true"
                className={jsonOpen ? "rotate-180 transition-transform" : "transition-transform"}
              />
              诊断详情（StatusNotice JSON）
            </button>
            {jsonOpen && (
              <pre className="mt-1 max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[#F7F9FC] p-2 font-mono text-[10px] leading-4 text-ink-muted">
                {JSON.stringify(notice, null, 2)}
              </pre>
            )}
          </div>
        )}
      </section>

      {/* ---- 本地操作日志 ---- */}
      <section className="min-h-0 flex-1 px-3 py-2">
        <p className="text-[10.5px] font-medium uppercase tracking-wide text-ink-faint">本地操作日志</p>
        {logs.length === 0 ? (
          <p className="mt-1 text-[11px] text-ink-faint">暂无操作。</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {logs.map((entry) => (
              <li key={entry.id} className="flex items-start gap-1.5 text-[10.5px] leading-4">
                <time className="shrink-0 font-mono tabular-nums text-ink-faint">
                  {formatClock(entry.at)}
                </time>
                <span className={logToneClass(entry.kind)}>{entry.text}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  tone = "default",
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: "default" | "warn" | "danger";
}) {
  const toneClass =
    tone === "danger" ? "text-[#B0443C]" : tone === "warn" ? "text-[#9A5B13]" : "text-ink";
  return (
    <div className="flex items-center gap-2">
      <dt className="shrink-0 text-[10.5px] text-ink-faint">{label}</dt>
      <dd className={`min-w-0 truncate ${toneClass} ${mono ? "font-mono tabular-nums" : ""}`}>{value}</dd>
    </div>
  );
}

function InterventionButton({
  icon,
  label,
  onClick,
  disabled,
  tone,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled: boolean;
  tone: "primary" | "ghost";
  /** 悬浮说明（悬浮显示，避免把 Token 成本写死在面板正文里）。 */
  hint?: string;
}) {
  const base =
    "inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-45";
  const style =
    tone === "primary"
      ? "bg-[#C2554E] text-white hover:bg-[#AE4943] disabled:hover:bg-[#C2554E]"
      : "border border-border bg-white text-ink-muted hover:bg-[#ECECEF] hover:text-ink disabled:hover:bg-white";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={hint}
      className={`${base} ${style}`}
    >
      {icon}
      {label}
    </button>
  );
}

/** 结论条的底色：介入=警示红、等你确认=暖黄、其余=中性。 */
function verdictSurface(decision: WatchdogVerdictDecision): string {
  if (decision === "intervene") return "bg-[#FDF1F0]";
  if (decision === "you") return "bg-[#FFFAEB]";
  return "bg-[#F7FAFF]";
}

/** 结论图标：与底色同色系，不用文字也能一眼分辨。 */
function verdictIcon(decision: WatchdogVerdictDecision) {
  const className = "shrink-0";
  if (decision === "intervene") {
    return <TriangleAlert size={12} strokeWidth={2} className={`${className} text-[#B0443C]`} />;
  }
  if (decision === "you") {
    return <Hand size={12} strokeWidth={2} className={`${className} text-[#8A6A16]`} />;
  }
  if (decision === "done") {
    return <CheckCircle2 size={12} strokeWidth={2} className={`${className} text-[#2F7A55]`} />;
  }
  return <Timer size={12} strokeWidth={2} className={`${className} text-ink-muted`} />;
}

/** 「在等谁」——把笼统的「卡住」拆成三件不同的事。 */
function awaitingLabel(awaiting: WatchdogAwaiting): string {
  if (awaiting === "tool") return "在等工具执行";
  if (awaiting === "user") return "在等你确认";
  return "在等模型出 token";
}

/** 结论后面跟的一句「那我现在干什么」。 */
function verdictHint(decision: WatchdogVerdictDecision): string {
  if (decision === "intervene") return " · 先试「极简询问」，还不动再「强制跳过」";
  if (decision === "you") return " · 需要你点一下确认，模型不会自己继续";
  if (decision === "done") return "";
  return " · 现在不用管";
}

function lightToneClass(tone: "running" | "stalled" | "failed" | "idle"): string {
  if (tone === "running") return "bg-[#34c38f] shadow-[0_0_0_2px_rgba(52,195,143,0.18)] animate-pulse";
  if (tone === "stalled") return "bg-[#e0a12b] shadow-[0_0_0_2px_rgba(224,161,43,0.22)] animate-pulse";
  if (tone === "failed") return "bg-[#c2554e] shadow-[0_0_0_2px_rgba(194,85,78,0.22)]";
  return "bg-[#CBD5E1]";
}

function logToneClass(kind: LogKind): string {
  if (kind === "ok") return "text-[#2F7A55]";
  if (kind === "error") return "text-[#B0443C]";
  return "text-ink-muted";
}

function formatClock(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 右侧导航栏图标上的小圆点：只有当前会话被标记 stalled 时才亮。
 *
 * 单独成组件是为了让订阅只发生在这颗 6px 的点上 ——
 * FilePanel 本身不订阅看门狗，整个右侧面板不会因此重渲。
 */
export function WatchdogTabBadge({ sessionId }: { sessionId: string | null }) {
  /**
   * 只反映**当前激活会话**的状态。
   *
   * 后台会话卡住由左栏会话灯的红色圆点负责提示；这里如果也跟着亮，用户会
   * 误以为「当前这个会话卡了」。点过去之后（sessionId 变了）它自然变红，
   * 与右侧面板展示的是同一个会话，语义始终一致。
   */
  return (
    <span className="pointer-events-none absolute right-0 top-0">
      <WatchdogDot sessionId={sessionId} />
    </span>
  );
}
