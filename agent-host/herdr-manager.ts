/**
 * Herdr agent fleet (v0.6.0 stage 9 step 3).
 *
 * A fleet agent is a persistent, isolated AgentSession with an in-memory
 * SessionManager. It is not a one-shot subagent: the main agent can query it
 * and send follow-up messages.
 *
 * Lifecycle status is the managed-process enum, guarded by process-state.ts.
 * This module never spawns OS processes; it reuses the same state-machine
 * invariants so fleet workers cannot invent their own lifecycle or leave a
 * terminal state.
 */
import { randomUUID } from "node:crypto";
import type { ThinkingLevel } from "./sdk-adapter.ts";
import type { Model } from "./sdk-adapter.ts";
import {
  DefaultResourceLoader,
  SessionManager,
  createHostAgentSession,
  getAgentDir,
} from "./sdk-adapter.ts";
import type { HerdrAgentView, HerdrActivity } from "../contract/domains/herdr.ts";
import type { ManagedProcessStatus } from "../contract/domains/processes.ts";
import type {
  SubagentToolCallView,
  SubagentVerification,
} from "../contract/domains/subagents.ts";
import { getSharedAuxRuntime } from "./aux-models.ts";
import { assertTransition, isTerminalStatus } from "./process-state.ts";
import { checkSubagentVerification } from "./subagent-verification.ts";
import {
  checkContextBreaker,
  checkTurnBudget,
  condenseReport,
  guardFailureText,
} from "./agent-guards.ts";
import { childToolSummary, resolveChildTools } from "./tool-grants.ts";
import { buildSubagentSystemPrompt, resolveSubagentPromptVariant } from "./subagent-prompt.ts";
import {
  advanceProgress,
  checkProgressBudget,
  initialProgressState,
  isProgressTool,
  type ProgressState,
} from "./progress-guard.ts";

const MAX_FLEET = 4;
const MAX_RETAINED = 20;
const MAX_OUTPUT_CHARS = 30_000;
/** 单轮超时（可被调用方覆盖）：到点 abort + 强制终止，绝不留挂在后台的 zombie。 */
const DEFAULT_TURN_TIMEOUT_MS = 5 * 60_000;
/**
 * 下限 1s：模型工具 schema 已经把调用方限制在 ≥30s，
 * 1s 只是为了让"超时收割"能在测试里真跑一遍而不是等半分钟。
 */
const MIN_TURN_TIMEOUT_MS = 1_000;
const MAX_TURN_TIMEOUT_MS = 30 * 60_000;
/**
 * 空闲托管：常驻舰队 Agent 跑完一轮就挂着，没人管就会像"跑了 1 小时"那样
 * 一直占着槽位（MAX_FLEET=4）和会话。空闲 5 分钟就自动休眠（dispose + stopped），
 * 想继续用重新唤醒即可 —— 省内存、省槽位，也不烧首轮 token。
 */
const IDLE_SLEEP_MS = 5 * 60_000;
const IDLE_SWEEP_INTERVAL_MS = 60_000;
/** 运行时没提供工具清单时的兜底（核心工具可下放，不再退回只读）。 */
const DEFAULT_CHILD_TOOLS = ["bash", "edit", "find", "grep", "ls", "read", "write"];

interface HerdrRecord {
  view: HerdrAgentView;
  session: Awaited<ReturnType<typeof createHostAgentSession>>["session"] | null;
  model?: Model<string>;
  thinkingLevel?: ThinkingLevel;
  cwd: string;
  tail: Promise<void>;
  lastTurnText: string;
  /** 舰队 Agent 的自定义 System Prompt / 工具集（来自配置或 herdr_spawn）。 */
  systemPrompt?: string;
  tools: string[];
  /** 完成即退出：一次性任务（herdr_spawn）跑完这一轮就退，不常驻挂机。 */
  autoExit: boolean;
  /** 本次派发的超时；到点强制终止。 */
  turnTimeoutMs: number;
  /** 省钱阀门：单轮上下文熔断标记。 */
  contextBreakerTripped: boolean;
  contextTokens: number | null;
  /** 空转计数（按可观测事件推进，见 progress-guard.ts）。 */
  progress: ProgressState;
  /** 本轮是否已经出现过进展工具。 */
  progressThisTurn: boolean;
}

const listeners = new Set<(agents: HerdrAgentView[]) => void>();

/** 常驻舰队的变更广播：面板靠它做实时同步（不再轮询 2s）。 */
export function onHerdrChange(listener: (agents: HerdrAgentView[]) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyHerdr(): void {
  const snapshotAgents = listHerdrAgents();
  for (const listener of listeners) {
    try {
      listener(snapshotAgents);
    } catch (error) {
      console.error("herdr listener failed:", error);
    }
  }
}

const records = new Map<string, HerdrRecord>();

function workingCount(): number {
  return [...records.values()].filter((record) => !isTerminalStatus(record.view.status)).length;
}

function pruneFinished(): void {
  const finished = [...records.values()]
    .filter((record) => isTerminalStatus(record.view.status))
    .sort((a, b) => (a.view.endedAt ?? 0) - (b.view.endedAt ?? 0));
  while (finished.length > MAX_RETAINED) {
    const oldest = finished.shift();
    if (oldest) records.delete(oldest.view.id);
  }
}

function snapshot(record: HerdrRecord): HerdrAgentView {
  return {
    ...record.view,
    durationMs: Math.max(0, (record.view.endedAt ?? Date.now()) - record.view.startedAt),
    finishedAt: record.view.endedAt,
    verified: record.view.verification.verified,
    toolCalls: record.view.toolCalls.map((call) => ({ ...call })),
    verification: { ...record.view.verification, evidence: [...record.view.verification.evidence] },
  };
}

export function listHerdrAgents(): HerdrAgentView[] {
  // 运行中（含 starting）优先，其次按开始时间倒序：新拉起的永远在最上面。
  return [...records.values()]
    .map(snapshot)
    .sort((a, b) => {
      const rank = (view: HerdrAgentView) => (isTerminalStatus(view.status) ? 1 : 0);
      const delta = rank(a) - rank(b);
      if (delta !== 0) return delta;
      return b.startedAt - a.startedAt;
    });
}

export function getHerdrAgent(id: string): HerdrAgentView | null {
  const record = records.get(id);
  return record ? snapshot(record) : null;
}

function setStatus(record: HerdrRecord, next: ManagedProcessStatus): void {
  if (record.view.status === next) return;
  assertTransition(record.view.status, next);
  record.view.status = next;
}

function setActivity(record: HerdrRecord, activity: HerdrActivity): void {
  record.view.activity = activity;
  record.view.lastActivityAt = Date.now();
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } =>
      Boolean(block) && typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

function appendOutput(record: HerdrRecord, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const combined = record.view.output ? `${record.view.output}\n\n${trimmed}` : trimmed;
  record.view.output = combined.length > MAX_OUTPUT_CHARS
    ? `…${combined.slice(-MAX_OUTPUT_CHARS)}`
    : combined;
}

/**
 * 舰队 Agent 的 prompt：与一次性子 Agent 共用 `subagent-prompt.ts` 的规则
 * （diff 必须可应用 / JSON 只管最终回复），只换开场白。
 */
function fleetSystemPrompt(cwd: string, tools: readonly string[]): string {
  return buildSubagentSystemPrompt({
    cwd,
    toolSummary: childToolSummary(tools),
    variant: resolveSubagentPromptVariant().variant,
    role: "fleet",
  });
}

function refreshVerification(record: HerdrRecord): void {
  const verification: SubagentVerification = checkSubagentVerification({
    output: record.view.output,
    toolCalls: record.view.toolCalls,
  });
  record.view.verification = verification;
}

function clampTimeout(value: number | undefined): number {
  if (!Number.isFinite(value ?? NaN) || !value) return DEFAULT_TURN_TIMEOUT_MS;
  return Math.min(MAX_TURN_TIMEOUT_MS, Math.max(MIN_TURN_TIMEOUT_MS, Math.round(value)));
}

async function runTurn(record: HerdrRecord, text: string, timeoutMs?: number): Promise<void> {
  const session = record.session;
  if (!session) throw new Error("Fleet agent is not running");
  /** 省钱阀门：熔断过就不再接受新指令，必须重新唤醒 / 新建。 */
  if (record.contextBreakerTripped) {
    throw new Error(
      guardFailureText(
        "context",
        `上下文已熔断（${record.contextTokens ?? "?"} tokens），请新建一个舰队 Agent 重新开始。`,
      ),
    );
  }
  record.view.turns += 1;
  record.view.error = undefined;
  record.lastTurnText = "";
  setActivity(record, "working");
  const limit = clampTimeout(timeoutMs ?? record.turnTimeoutMs);
  const timer = setTimeout(() => {
    // 主 Agent 超时收割：abort + 强制终止，槽位立刻释放。
    void stopHerdrAgent(
      record.view.id,
      `超过 ${Math.round(limit / 60_000)} 分钟未完成，已强制终止`,
    );
  }, limit);
  timer.unref?.();
  try {
    await session.prompt(text);
  } catch (error) {
    record.view.error = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timer);
    setActivity(record, "idle");
    refreshVerification(record);
    // 完成即退出：一次性任务跑完就退，不再常驻后台挂着烧槽位。
    if (record.autoExit && record.view.status === "running") {
      setStatus(record, "exited");
      record.view.endedAt = Date.now();
      record.session?.dispose();
      record.session = null;
    }
    if (record.view.status === "stopping") {
      setStatus(record, "stopped");
      record.view.endedAt = Date.now();
    }
    notifyHerdr();
  }
}

async function initialize(record: HerdrRecord, initialTask: string | null): Promise<void> {
  try {
    const agentDir = getAgentDir();
    const resourceLoader = new DefaultResourceLoader({
      cwd: record.cwd,
      agentDir,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: record.systemPrompt?.trim() || fleetSystemPrompt(record.cwd, record.tools),
    });
    await resourceLoader.reload();
    const { session } = await createHostAgentSession({
      cwd: record.cwd,
      agentDir,
      modelRuntime: await getSharedAuxRuntime(),
      sessionManager: SessionManager.inMemory(record.cwd),
      resourceLoader,
      ...(record.model ? { model: record.model } : {}),
      ...(record.thinkingLevel ? { thinkingLevel: record.thinkingLevel } : {}),
      tools: record.tools.length > 0 ? record.tools : DEFAULT_CHILD_TOOLS,
    });
    if (record.view.status === "stopping" || isTerminalStatus(record.view.status)) {
      session.dispose();
      return;
    }
    record.session = session;
    if (record.view.status === "starting") setStatus(record, "running");
    notifyHerdr();

    session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        /** 省钱阀门：单轮上下文熔断（舰队 Agent 常驻，更要防止越聊越贵）。 */
        const usage = event.message.usage;
        const tokens = usage
          ? (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.output ?? 0)
          : record.contextTokens;
        record.contextTokens = tokens ?? null;
        const breach = checkContextBreaker(record.contextTokens);
        if (breach.breached) {
          record.contextBreakerTripped = true;
          record.view.error = guardFailureText("context", breach.reason ?? "上下文超限");
          setActivity(record, "idle");
          void session.abort().catch(() => undefined);
          notifyHerdr();
          return;
        }
        /**
         * 约束 4：「无进展」按可观测事件判定（读了文件 / 跑了命令 / 改了代码）。
         * 舰队 Agent 常驻、没有轮数上限，所以这条是它**唯一**的空转刹车：
         * 连续 5 轮什么都没做才停，探索性任务前几轮只读代码不会被误杀。
         */
        record.progress = advanceProgress(record.progress, record.progressThisTurn);
        record.progressThisTurn = false;
        const progressBudget = checkProgressBudget(record.progress);
        if (progressBudget.stop) {
          record.view.error = guardFailureText("progress", progressBudget.reason ?? "空转");
          setActivity(record, "idle");
          void session.abort().catch(() => undefined);
          notifyHerdr();
          return;
        }
        const text = textOfContent(event.message.content).trim();
        record.lastTurnText = text || record.lastTurnText;
        appendOutput(record, text);
        notifyHerdr();
        return;
      }
      if (event.type === "tool_execution_start") {
        if (isProgressTool(event.toolName)) record.progressThisTurn = true;
        const args = (event.args ?? {}) as Record<string, unknown>;
        const raw = args.path ?? args.pattern ?? args.query;
        const call: SubagentToolCallView = {
          id: event.toolCallId,
          name: event.toolName,
          status: "running",
          startedAt: Date.now(),
          endedAt: null,
          ...(typeof raw === "string" ? { detail: raw.slice(0, 500) } : {}),
        };
        record.view.toolCalls.push(call);
        notifyHerdr();
        return;
      }
      if (event.type === "tool_execution_end") {
        const call = record.view.toolCalls.find((item) => item.id === event.toolCallId);
        if (call) {
          call.status = event.isError ? "error" : "ok";
          call.endedAt = Date.now();
          notifyHerdr();
        }
      }
    });

    // 常驻配置唤醒：只建会话，等用户 / 主 Agent 的第一条消息（不烧首轮 token）。
    if (initialTask !== null) await runTurn(record, initialTask);
    else {
      // 空转唤醒：没有在跑任何一轮，标记空闲，否则空闲托管永远扫不到它。
      setActivity(record, "idle");
      notifyHerdr();
    }
  } catch (error) {
    record.view.error = error instanceof Error ? error.message : String(error);
    if (!isTerminalStatus(record.view.status)) {
      setStatus(record, "crashed");
      record.view.endedAt = Date.now();
    }
    setActivity(record, "idle");
    try {
      record.session?.dispose();
    } catch {
      // already gone
    }
    record.session = null;
    notifyHerdr();
  }
}

export interface SpawnHerdrInput {
  name: string;
  task: string;
  cwd: string;
  parentSessionId: string;
  model?: Model<string>;
  thinkingLevel?: ThinkingLevel;
  /** 舰队配置里的自定义 System Prompt（不填用内置模板）。 */
  systemPrompt?: string;
  /** 父 Agent / 配置显式要求的工具（按需放开，与继承结果取并集）。 */
  tools?: string[];
  /** 父 Agent 当前 activeTools：默认继承。 */
  parentActiveTools?: string[];
  /** 运行时全量工具注册表（不是存根目录）。 */
  availableTools?: string[];
  /** 唤醒常驻配置：只建会话，不跑首轮。 */
  idle?: boolean;
  /** 派发超时（ms）；到点 abort + 强制终止。默认 5 分钟。 */
  timeoutMs?: number;
}

export function spawnHerdrAgent(input: SpawnHerdrInput): HerdrAgentView {
  const name = input.name?.trim();
  const task = (input.task ?? "").trim();
  if (!name) throw new Error("name is required");
  // idle 唤醒（常驻配置）允许没有首轮任务；其它情况仍然要求 taskPrompt。
  if (!task && input.idle !== true) throw new Error("taskPrompt is required");
  if (workingCount() >= MAX_FLEET) {
    throw new Error(`Fleet is full (limit ${MAX_FLEET}); stop an agent before spawning another.`);
  }
  pruneFinished();
  const id = `herdr-${randomUUID().slice(0, 12)}`;
  const record: HerdrRecord = {
    view: {
      id,
      name,
      task,
      parentSessionId: input.parentSessionId,
      cwd: input.cwd,
      status: "starting",
      activity: "working",
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      endedAt: null,
      durationMs: 0,
      finishedAt: null,
      verified: false,
      turns: 0,
      output: "",
      toolCalls: [],
      verification: {
        verified: false,
        checkedAt: Date.now(),
        reason: "Fleet turn in progress",
        evidence: [],
      },
    },
    session: null,
    ...(input.model ? { model: input.model } : {}),
    ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
    cwd: input.cwd,
    tail: Promise.resolve(),
    lastTurnText: "",
    ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
    tools: resolveChildTools({
      name,
      requested: input.tools,
      parentActive: input.parentActiveTools,
      available: input.availableTools && input.availableTools.length > 0
        ? input.availableTools
        : DEFAULT_CHILD_TOOLS,
    }).tools,
    autoExit: input.idle !== true,
    turnTimeoutMs: clampTimeout(input.timeoutMs),
    contextBreakerTripped: false,
    contextTokens: null,
    progress: initialProgressState(),
    progressThisTurn: false,
  };
  records.set(id, record);
  ensureIdleReaper();
  record.tail = initialize(record, input.idle === true ? null : task);
  notifyHerdr();
  return snapshot(record);
}

/** 从常驻配置唤醒一个舰队 Agent（不跑首轮，等人 / 主 Agent 给指令）。 */
export function wakeFleetAgent(input: {
  name: string;
  cwd: string;
  parentSessionId: string;
  systemPrompt: string;
  tools?: string[];
  model?: Model<string>;
  thinkingLevel?: ThinkingLevel;
}): HerdrAgentView {
  const existing = [...records.values()].find(
    (record) => record.view.name === input.name && !isTerminalStatus(record.view.status),
  );
  if (existing) return snapshot(existing);
  return spawnHerdrAgent({
    name: input.name,
    task: "",
    cwd: input.cwd,
    parentSessionId: input.parentSessionId,
    systemPrompt: input.systemPrompt,
    ...(input.model ? { model: input.model } : {}),
    ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
    ...(input.tools ? { tools: input.tools } : {}),
    idle: true,
  });
}

/** State-machine guard used by both the manager and its unit test. */
export function assertHerdrMessageAllowed(status: ManagedProcessStatus): void {
  if (status === "stopping" || isTerminalStatus(status)) {
    throw new Error(`Fleet agent is ${status}; no messages accepted (status: ${status})`);
  }
}

export interface HerdrMessageResult {
  ok: boolean;
  agent: HerdrAgentView;
  text: string;
  error?: string;
}

export async function sendHerdrMessage(
  id: string,
  message: string,
  timeoutMs?: number,
): Promise<HerdrMessageResult> {
  const record = records.get(id);
  if (!record) throw new Error(`No fleet agent with id "${id}"`);
  assertHerdrMessageAllowed(record.view.status);
  const trimmed = message?.trim();
  if (!trimmed) throw new Error("message is required");
  /**
   * 省钱阀门：主 Agent ↔ 子 Agent 只能「单次请求-响应」，最多 3 轮。
   * 第 4 轮直接被拒（不是软提醒），避免在同一段上下文里反复加价。
   */
  const postTurn = checkTurnBudget(record.view.turns);
  if (!postTurn.allowed) {
    throw new Error(guardFailureText("turns", postTurn.reason ?? "超过轮数上限"));
  }
  if (record.contextBreakerTripped) {
    throw new Error(
      guardFailureText(
        "context",
        `上下文已熔断（${record.contextTokens ?? "?"} tokens），请新建一个舰队 Agent。`,
      ),
    );
  }
  await record.tail;
  if (isTerminalStatus(record.view.status) || !record.session) {
    throw new Error("Fleet agent is no longer running");
  }
  // 主 Agent 派发即带超时：这一轮超时就收掉，不让它继续挂。
  const next = runTurn(record, trimmed, timeoutMs ?? record.turnTimeoutMs);
  record.tail = next;
  await next;
  const agent = getHerdrAgent(id)!;
  /** 回给调用方的永远是极简摘要，原始输出留在面板。 */
  const report = condenseReport(record.lastTurnText || "(no text output)");
  notifyHerdr();
  return {
    ok: !agent.error,
    agent,
    text: report.text,
    ...(agent.error ? { error: agent.error } : {}),
  };
}

export async function stopHerdrAgent(id: string, reason?: string): Promise<boolean> {
  const record = records.get(id);
  if (!record || isTerminalStatus(record.view.status)) return false;
  setStatus(record, "stopping");
  record.session?.abort().catch(() => undefined);
  try {
    record.session?.dispose();
  } catch {
    // already gone
  }
  record.session = null;
  setActivity(record, "idle");
  if (reason) record.view.error = reason;
  setStatus(record, "stopped");
  record.view.endedAt = Date.now();
  refreshVerification(record);
  notifyHerdr();
  return true;
}

export async function stopAllHerdrAgents(): Promise<void> {
  for (const id of [...records.keys()]) await stopHerdrAgent(id);
}

/**
 * 空闲托管扫描：把 `activity === "idle"` 且超过 `maxIdleMs` 没动过的 Agent 休眠掉。
 * 返回被休眠的 id，方便调用方/测试断言。运行中（working）的一律不动。
 */
/** 单条判定（纯函数，便于断言"干活中的绝不回收"）。 */
export function shouldSleepIdle(
  view: Pick<HerdrAgentView, "status" | "activity" | "lastActivityAt">,
  now: number,
  maxIdleMs: number,
): boolean {
  if (view.status === "starting") return false;
  if (isTerminalStatus(view.status)) return false;
  if (view.activity === "working") return false;
  return now - view.lastActivityAt >= maxIdleMs;
}

export function sweepIdleHerdrAgents(
  options: { now?: number; maxIdleMs?: number } = {},
): string[] {
  const now = options.now ?? Date.now();
  const maxIdleMs = options.maxIdleMs ?? IDLE_SLEEP_MS;
  const slept: string[] = [];
  for (const record of [...records.values()]) {
    if (!shouldSleepIdle(record.view, now, maxIdleMs)) continue;
    void stopHerdrAgent(
      record.view.id,
      `空闲 ${Math.round(maxIdleMs / 60_000)} 分钟，已自动休眠（省内存/省槽位）`,
    );
    slept.push(record.view.id);
  }
  return slept;
}

let idleReaper: ReturnType<typeof setInterval> | null = null;

/** 懒启动的空闲托管定时器：第一次 spawn 才跑，不拖慢 Host 启动。 */
function ensureIdleReaper(): void {
  if (idleReaper) return;
  idleReaper = setInterval(() => {
    try {
      sweepIdleHerdrAgents();
    } catch (error) {
      console.error("herdr idle reaper failed:", error);
    }
  }, IDLE_SWEEP_INTERVAL_MS);
  idleReaper.unref?.();
}

/** Test hook. */
export function resetHerdrForTest(): void {
  records.clear();
}
