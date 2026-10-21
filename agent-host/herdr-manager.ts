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

const MAX_FLEET = 4;
const MAX_RETAINED = 20;
const MAX_OUTPUT_CHARS = 30_000;
const TURN_TIMEOUT_MS = 15 * 60_000;
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

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
  /** 省钱阀门：单轮上下文熔断标记。 */
  contextBreakerTripped: boolean;
  contextTokens: number | null;
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

function fleetSystemPrompt(cwd: string): string {
  return [
    "You are a persistent PiForge fleet agent. Work independently on the task you are given.",
    "You have only read-only tools: read, grep, find, ls. You cannot edit files, run shell commands, or ask follow-up questions.",
    "You may receive follow-up messages from the main agent; keep context between them.",
    "When finished, answer with a concise, self-contained report (findings, file paths with line numbers, recommendation).",
    `Working directory: ${cwd}`,
  ].join("\n");
}

function refreshVerification(record: HerdrRecord): void {
  const verification: SubagentVerification = checkSubagentVerification({
    output: record.view.output,
    toolCalls: record.view.toolCalls,
  });
  record.view.verification = verification;
}

async function runTurn(record: HerdrRecord, text: string): Promise<void> {
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
  const timer = setTimeout(() => {
    record.view.error = "Fleet turn timed out";
    void session.abort().catch(() => undefined);
  }, TURN_TIMEOUT_MS);
  timer.unref?.();
  try {
    await session.prompt(text);
  } catch (error) {
    record.view.error = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timer);
    setActivity(record, "idle");
    refreshVerification(record);
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
      systemPrompt: record.systemPrompt?.trim() || fleetSystemPrompt(record.cwd),
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
      tools: record.tools.length > 0 ? record.tools : READ_ONLY_TOOLS,
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
        const text = textOfContent(event.message.content).trim();
        record.lastTurnText = text || record.lastTurnText;
        appendOutput(record, text);
        notifyHerdr();
        return;
      }
      if (event.type === "tool_execution_start") {
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
    else notifyHerdr();
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
  /** 舰队配置里的工具白名单（只读工具）。 */
  tools?: string[];
  /** 唤醒常驻配置：只建会话，不跑首轮。 */
  idle?: boolean;
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
      status: "starting",
      activity: "working",
      startedAt: Date.now(),
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
    tools: input.tools && input.tools.length > 0 ? [...input.tools] : [...READ_ONLY_TOOLS],
    contextBreakerTripped: false,
    contextTokens: null,
  };
  records.set(id, record);
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

export async function sendHerdrMessage(id: string, message: string): Promise<HerdrMessageResult> {
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
  const next = runTurn(record, trimmed);
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

export async function stopHerdrAgent(id: string): Promise<boolean> {
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
  setStatus(record, "stopped");
  record.view.endedAt = Date.now();
  refreshVerification(record);
  notifyHerdr();
  return true;
}

export async function stopAllHerdrAgents(): Promise<void> {
  for (const id of [...records.keys()]) await stopHerdrAgent(id);
}

/** Test hook. */
export function resetHerdrForTest(): void {
  records.clear();
}
