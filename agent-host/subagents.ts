/**
 * Sub-agent manager (v0.5.0 stage 7).
 *
 * Each child agent is a separate AgentSession with:
 *   - its own in-memory SessionManager (never touches the parent JSONL)
 *   - no user extensions / MCP / desktop tools (no recursion, no UI side effects)
 *   - read-only builtin tools (read / grep / find / ls)
 *   - the parent's model + thinking level
 *
 * The manager tracks live status/output for the Agents panel and returns the
 * child's final answer to the `spawn_agent` tool.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  DefaultResourceLoader,
  SessionManager,
  createHostAgentSession,
  getAgentDir,
} from "./sdk-adapter.ts";
import type { ThinkingLevel } from "./sdk-adapter.ts";
import type { Model } from "./sdk-adapter.ts";
import type {
  SubagentLifecycleEvent,
  SubagentToolCallView,
  SubagentView,
} from "../contract/domains/subagents.ts";
import { getSharedAuxRuntime } from "./aux-models.ts";
import { checkSubagentVerification } from "./subagent-verification.ts";
import {
  buildSubagentFailureReport,
  checkContextBreaker,
  checkTurnBudget,
  condenseReport,
  guardFailureText,
  resolveSubagentMaxTurns,
  type GuardTrip,
} from "./agent-guards.ts";
import { childToolSummary, resolveChildTools, type ResolvedChildTools } from "./tool-grants.ts";
import {
  buildSubagentSystemPrompt,
  resolveSubagentPromptVariant,
  type SubagentPromptVariant,
} from "./subagent-prompt.ts";
import {
  advanceProgress,
  checkProgressBudget,
  initialProgressState,
  isProgressTool,
  type ProgressState,
} from "./progress-guard.ts";
import { resolveChildSessionDir } from "./session-isolation.ts";

const MAX_RUNNING = 4;
const MAX_FINISHED = 20;
const MAX_OUTPUT_CHARS = 20_000;
const SUBAGENT_TIMEOUT_MS = 15 * 60_000;
/**
 * 运行时没有提供工具清单时的兜底（老调用点 / 单测）。
 * 默认按「核心工具可下放」处理，不再退回只读：只读会让子 Agent 变瞎子。
 */
const DEFAULT_CHILD_TOOLS = ["bash", "edit", "find", "grep", "ls", "read", "write"];

export class SubagentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubagentError";
  }
}

interface SubagentRecord {
  view: SubagentView;
  session: Awaited<ReturnType<typeof createHostAgentSession>>["session"] | null;
  abort: AbortController;
  timedOut: boolean;
  lastAssistantText: string;
  /** 省钱阀门：子 Agent 自己的对话轮数（最多 3 轮）。 */
  assistantTurns: number;
  /** 省钱阀门：最近一次观测到的上下文 token。 */
  contextTokens: number | null;
  /** 省钱阀门：轮数上限（`PIFORGE_SUBAGENT_MAX_TURNS`，默认 6）。 */
  maxTurns: number;
  /** 熔断原因（命中后立刻中断，并把原因回给主 Agent）。 */
  guardTrip: GuardTrip | null;
  /** 累计用量（成本 / 输出 token 采集：面板与对照实验共用）。 */
  usage: { input: number; cacheRead: number; output: number; cost: number };
  /** 空转计数（按可观测事件推进，见 progress-guard.ts）。 */
  progress: ProgressState;
  /** 本轮是否已经出现过进展工具（在 assistant 回合结束时结算）。 */
  progressThisTurn: boolean;
}

const records = new Map<string, SubagentRecord>();
const listeners = new Set<(event?: SubagentLifecycleEvent) => void>();

export function onSubagentsChange(listener: (event?: SubagentLifecycleEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(event?: SubagentLifecycleEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      console.error("subagent listener failed:", error);
    }
  }
}

function snapshotView(record: SubagentRecord): SubagentView {
  const view = record.view;
  return {
    ...view,
    durationMs: Math.max(0, (view.endedAt ?? Date.now()) - view.startedAt),
    toolCalls: view.toolCalls.map((call) => ({ ...call })),
  };
}

/**
 * 列表顺序 = 面板顺序：**运行中的永远在最上面**，其余按开始时间倒序。
 * 只按 startedAt 排会让"刚拉起的那个"被并发启动的旧任务挤下去。
 */
export function listSubagents(): SubagentView[] {
  return [...records.values()]
    .map(snapshotView)
    .sort((a, b) => {
      const runningRank = (view: SubagentView) => (view.status === "running" ? 0 : 1);
      const rank = runningRank(a) - runningRank(b);
      if (rank !== 0) return rank;
      return b.startedAt - a.startedAt;
    });
}

export function stopSubagent(id: string): boolean {
  const record = records.get(id);
  if (!record || record.view.status !== "running") return false;
  record.abort.abort();
  void record.session?.abort().catch(() => undefined);
  return true;
}

/** Test hook: drop every record without touching running sessions. */
export function resetSubagentsForTest(): void {
  records.clear();
}

export async function stopAllSubagents(): Promise<void> {
  const running = [...records.values()].filter((record) => record.view.status === "running");
  for (const record of running) {
    record.abort.abort();
    await record.session?.abort().catch(() => undefined);
  }
}

function pruneFinished(): void {
  const finished = [...records.values()]
    .filter((record) => record.view.status !== "running")
    .sort((a, b) => (a.view.endedAt ?? 0) - (b.view.endedAt ?? 0));
  while (finished.length > MAX_FINISHED) {
    const oldest = finished.shift();
    if (oldest) records.delete(oldest.view.id);
  }
}

function runningCount(): number {
  return [...records.values()].filter((record) => record.view.status === "running").length;
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } =>
      Boolean(block) && typeof block === "object" && (block as { type?: string }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

function lastAssistantText(entries: unknown[]): string {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index] as { type?: string; message?: { role?: string; content?: unknown } } | null;
    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
    const text = textOfContent(entry.message.content).trim();
    if (text) return text;
  }
  return "";
}

function toolDetail(name: string, args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const values = args as Record<string, unknown>;
  const raw = name === "bash" || name === "powershell"
    ? values.command
    : values.path ?? values.file_path ?? values.pattern ?? values.query;
  if (typeof raw !== "string") return undefined;
  const clean = raw.replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, 500) : undefined;
}

/**
 * 「最后一次有效动作」：回给主 Agent 的诊断锚点。
 *
 * 只看**算作进展**的工具（read / grep / bash / edit…）—— 元动作（tool_search、
 * spawn_agent 之类）不改变对任务的理解，拿它当"最后动作"会误导主 Agent。
 */
function lastEffectiveAction(calls: SubagentToolCallView[]): string | null {
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index];
    if (!isProgressTool(call.name)) continue;
    const detail = call.detail ? ` ${call.detail}` : "";
    const state = call.status === "ok" ? "ok" : call.status === "error" ? "error" : "running";
    return `${call.name}${detail}（${state}）`;
  }
  return null;
}

function appendOutput(record: SubagentRecord, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const combined = record.view.output ? `${record.view.output}\n\n${trimmed}` : trimmed;
  record.view.output = combined.length > MAX_OUTPUT_CHARS
    ? `…${combined.slice(-MAX_OUTPUT_CHARS)}`
    : combined;
}

/**
 * 子 Agent 的 system prompt：文本本体在 `subagent-prompt.ts`（单一事实来源，
 * 对照实验要逐字节复现旧文本）。`PIFORGE_SUBAGENT_PROMPT=legacy` 可回退旧口径。
 */
function childSystemPrompt(
  cwd: string,
  grants: ResolvedChildTools,
  variant: SubagentPromptVariant = resolveSubagentPromptVariant().variant,
): string {
  return buildSubagentSystemPrompt({
    cwd,
    toolSummary: childToolSummary(grants.tools, grants.denied),
    variant,
    role: "subagent",
  });
}

export interface SpawnSubagentInput {
  name: string;
  task: string;
  cwd: string;
  parentSessionId: string;
  model?: Model<string>;
  thinkingLevel?: ThinkingLevel;
  signal?: AbortSignal;
  /** 父 Agent 显式要求的工具（按需放开，取并集）。 */
  tools?: string[];
  /** 父 Agent 当前 activeTools：默认继承，不再"只读阉割"。 */
  parentActiveTools?: string[];
  /** 运行时全量工具注册表（不是存根目录）。 */
  availableTools?: string[];
}

export interface SpawnSubagentResult {
  agent: SubagentView;
  ok: boolean;
  text: string;
  error?: string;
}

export async function spawnSubagent(input: SpawnSubagentInput): Promise<SpawnSubagentResult> {
  const name = input.name?.trim();
  const task = input.task?.trim();
  if (!name) throw new SubagentError("name is required");
  if (!task) throw new SubagentError("taskPrompt is required");
  if (input.signal?.aborted) throw new SubagentError("The parent turn was aborted");
  /**
   * 工具授权：缺权限的请求**在这里**就抛出去（spawn_agent 会把它变成工具错误），
   * 子 Agent 不会带着残缺工具跑到熔断再报「我没法执行」。
   */
  const grants = resolveChildTools({
    name,
    requested: input.tools,
    parentActive: input.parentActiveTools,
    available: input.availableTools && input.availableTools.length > 0
      ? input.availableTools
      : DEFAULT_CHILD_TOOLS,
  });
  if (runningCount() >= MAX_RUNNING) {
    throw new SubagentError(
      `Too many sub-agents are already running (limit ${MAX_RUNNING}). Wait for one to finish or split the work into fewer tasks.`,
    );
  }
  pruneFinished();

  const id = `subagent-${randomUUID().slice(0, 12)}`;
  const abort = new AbortController();
  /** 轮数上限：可配置（默认 6）+ 空转阀（连续 5 轮无进展）优先。 */
  const turnLimit = resolveSubagentMaxTurns(process.env);
  const record: SubagentRecord = {
    view: {
      id,
      name,
      task,
      parentSessionId: input.parentSessionId,
      cwd: input.cwd,
      status: "running",
      startedAt: Date.now(),
      endedAt: null,
      durationMs: 0,
      output: "",
      toolCalls: [],
    },
    session: null,
    abort,
    timedOut: false,
    lastAssistantText: "",
    assistantTurns: 0,
    contextTokens: null,
    maxTurns: turnLimit.maxTurns,
    guardTrip: null,
    usage: { input: 0, cacheRead: 0, output: 0, cost: 0 },
    progress: initialProgressState(),
    progressThisTurn: false,
  };
  records.set(id, record);
  notify({ type: "subagent_started", agent: snapshotView(record), timestamp: Date.now() });

  const onParentAbort = () => {
    abort.abort();
    void record.session?.abort().catch(() => undefined);
  };
  input.signal?.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => {
    record.timedOut = true;
    abort.abort();
    void record.session?.abort().catch(() => undefined);
  }, SUBAGENT_TIMEOUT_MS);
  timer.unref?.();

  let unsubscribe: (() => void) | null = null;
  let ok = false;
  let finalText = "";
  try {
    const agentDir = getAgentDir();
    /**
     * 约束 3：子 Agent 的会话**必须是隔离的**。
     * 现状是 `SessionManager.inMemory()`（不落盘）；`PIFORGE_SESSION_DIR` 一旦被设置，
     * 只会用于需要落盘的实验/工具，并在这里被守卫一次 —— 指向共享 `sessions/` 就拒绝。
     */
    const isolation = resolveChildSessionDir(process.env, join(agentDir, "sessions"));
    if (process.env.PIFORGE_DEBUG_SUBAGENT === "1") {
      console.log(`[subagent] session isolation: ${isolation.reason}`);
    }
    const resourceLoader = new DefaultResourceLoader({
      cwd: input.cwd,
      agentDir,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: childSystemPrompt(input.cwd, grants),
    });
    await resourceLoader.reload();

    const runtime = await getSharedAuxRuntime();
    const { session } = await createHostAgentSession({
      cwd: input.cwd,
      agentDir,
      modelRuntime: runtime,
      sessionManager: SessionManager.inMemory(input.cwd),
      resourceLoader,
      ...(input.model ? { model: input.model } : {}),
      ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
      tools: grants.tools,
    });
    record.session = session;

    unsubscribe = session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        /** 即将收尾的第几轮（1 起）；判据见 agent-guards.checkTurnBudget。 */
        const nextTurn = record.assistantTurns + 1;
        record.assistantTurns = nextTurn;
        /** 采集：累计用量（成本/输出 token 在面板与对照实验里都要用）。 */
        const usage = event.message.usage;
        if (usage) {
          record.usage = {
            input: record.usage.input + (usage.input ?? 0),
            cacheRead: record.usage.cacheRead + (usage.cacheRead ?? 0),
            output: record.usage.output + (usage.output ?? 0),
            cost: record.usage.cost + (usage.cost?.total ?? 0),
          };
        }
        /**
         * 约束 4：「无进展」按**可观测事件**判定（读了文件 / 跑了命令 / 改了代码），
         * 不是"这一轮没给结论"。探索性任务前几轮只读代码不该被误杀。
         *
         * 顺序：空转阀 **先**于轮数上限检查 —— 轮数上限（默认 6）刻意高于空转阈值（5），
         * 否则轮数先触发，空转保护永远轮不到生效（实测过的旧 bug）。
         */
        record.progress = advanceProgress(record.progress, record.progressThisTurn);
        record.progressThisTurn = false;
        const progressBudget = checkProgressBudget(record.progress);
        if (progressBudget.stop) {
          record.guardTrip = record.guardTrip ?? "progress";
          record.view.error = guardFailureText("progress", progressBudget.reason ?? "空转");
          abort.abort();
          void session.abort().catch(() => undefined);
          notify({
            type: "subagent_output",
            id: record.view.id,
            name: record.view.name,
            text: record.view.error,
            timestamp: Date.now(),
          });
          return;
        }

        const contextTokens = usage
          ? (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.output ?? 0)
          : record.contextTokens;
        record.contextTokens = contextTokens ?? null;
        const breach = checkContextBreaker(record.contextTokens);
        if (breach.breached) {
          record.guardTrip = "context";
          record.view.error = guardFailureText("context", breach.reason ?? "上下文超限");
          abort.abort();
          void session.abort().catch(() => undefined);
          notify({ type: "subagent_output", id: record.view.id, name: record.view.name, text: record.view.error, timestamp: Date.now() });
          return;
        }

        /**
         * 省钱阀门一：轮数上限（默认 6，可配），**最后**检查。
         * 触达后也先中断（不把上下文无限拉长），但回包走 need_help 报告，不静默 abort。
         */
        const budget = checkTurnBudget(nextTurn, record.maxTurns);
        if (!budget.allowed) {
          record.guardTrip = "turns";
          record.view.error = guardFailureText("turns", budget.reason ?? "超过轮数上限");
          abort.abort();
          void session.abort().catch(() => undefined);
          notify({ type: "subagent_output", id: record.view.id, name: record.view.name, text: record.view.error, timestamp: Date.now() });
          return;
        }
        const text = textOfContent(event.message.content);
        record.lastAssistantText = text.trim() || record.lastAssistantText;
        appendOutput(record, text);
        if (text.trim()) {
          notify({
            type: "subagent_output",
            id: record.view.id,
            name: record.view.name,
            text: text.trim(),
            timestamp: Date.now(),
          });
        }
        return;
      }
      if (event.type === "tool_execution_start") {
        if (isProgressTool(event.toolName)) record.progressThisTurn = true;
        const detail = toolDetail(event.toolName, event.args);
        const call: SubagentToolCallView = {
          id: event.toolCallId,
          name: event.toolName,
          status: "running",
          startedAt: Date.now(),
          endedAt: null,
          ...(detail ? { detail } : {}),
        };
        record.view.toolCalls.push(call);
        notify({
          type: "subagent_output",
          id: record.view.id,
          name: record.view.name,
          text: "",
          toolCall: { ...call },
          timestamp: Date.now(),
        });
        return;
      }
      if (event.type === "tool_execution_end") {
        const call = record.view.toolCalls.find((entry) => entry.id === event.toolCallId);
        if (call) {
          call.status = event.isError ? "error" : "ok";
          call.endedAt = Date.now();
          notify({
            type: "subagent_output",
            id: record.view.id,
            name: record.view.name,
            text: "",
            toolCall: { ...call },
            timestamp: Date.now(),
          });
        }
      }
    });

    await session.prompt(task);

    const cancelled = abort.signal.aborted;
    record.view.status = cancelled ? "cancelled" : "completed";
    finalText = lastAssistantText(session.sessionManager.getBranch()) || record.lastAssistantText;
    if (cancelled) {
      /** 阀门原文不能被 "Cancelled" 盖掉 —— 主 Agent 靠它区分缺上下文与死循环。 */
      const guardText = record.guardTrip ? record.view.error : undefined;
      record.view.error = record.timedOut
        ? `Timed out after ${Math.round(SUBAGENT_TIMEOUT_MS / 60_000)} minutes`
        : guardText ?? "Cancelled";
    } else {
      ok = true;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    record.view.status = abort.signal.aborted ? "cancelled" : "failed";
    record.view.error = message;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onParentAbort);
    unsubscribe?.();
    record.view.endedAt = Date.now();
    if (record.view.status === "running") {
      record.view.status = "failed";
      record.view.error = record.view.error ?? "Sub-agent ended unexpectedly";
    }
    try {
      record.session?.dispose();
    } catch {
      // Session already gone.
    }
    record.session = null;
    record.view.verification = checkSubagentVerification({
      output: record.view.output,
      toolCalls: record.view.toolCalls,
    });
    notify({ type: "subagent_finished", agent: snapshotView(record), timestamp: Date.now() });
  }

  const agent = snapshotView(record);
  if (ok) {
    /**
     * 省钱阀门三：回给主 Agent 的永远是极简摘要（原始输出只在面板里）。
     * 几千行日志直接回灌主上下文，会让后面每一轮都变贵。
     */
    const report = condenseReport(finalText || "(no text output)");
    const verification = agent.verification;
    const verificationLine = verification?.verified
      ? `Verification: test/build evidence found (${verification.reason}).`
      : `Verification: UNVERIFIED — ${verification?.reason ?? "no test evidence"}. This did not block completion; treat the report as research, not a validated change.`;
    return {
      agent,
      ok: true,
      text: `Sub-agent "${name}" completed.

${report.text}

${verificationLine}`,
    };
  }
  const reason = record.view.error ?? "unknown error";
  return {
    agent,
    ok: false,
    text: buildSubagentFailureReport({
      id: record.view.id,
      name,
      status: record.view.status,
      trip: record.guardTrip,
      turns: record.assistantTurns,
      maxTurns: record.maxTurns,
      lastAction: lastEffectiveAction(record.view.toolCalls),
      reason,
      timedOut: record.timedOut,
    }),
    error: reason,
  };
}
