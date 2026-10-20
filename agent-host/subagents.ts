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
import {
  DefaultResourceLoader,
  SessionManager,
  createAgentSession,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type {
  SubagentLifecycleEvent,
  SubagentToolCallView,
  SubagentView,
} from "../contract/domains/subagents.ts";
import { getSharedAuxRuntime } from "./aux-models.ts";

const MAX_RUNNING = 4;
const MAX_FINISHED = 20;
const MAX_OUTPUT_CHARS = 20_000;
const SUBAGENT_TIMEOUT_MS = 15 * 60_000;
/** Read-only work keeps children away from writes and the shell. */
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

export class SubagentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubagentError";
  }
}

interface SubagentRecord {
  view: SubagentView;
  session: Awaited<ReturnType<typeof createAgentSession>>["session"] | null;
  abort: AbortController;
  timedOut: boolean;
  lastAssistantText: string;
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

export function listSubagents(): SubagentView[] {
  return [...records.values()]
    .map(snapshotView)
    .sort((a, b) => b.startedAt - a.startedAt);
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

function appendOutput(record: SubagentRecord, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const combined = record.view.output ? `${record.view.output}\n\n${trimmed}` : trimmed;
  record.view.output = combined.length > MAX_OUTPUT_CHARS
    ? `…${combined.slice(-MAX_OUTPUT_CHARS)}`
    : combined;
}

function childSystemPrompt(cwd: string): string {
  return [
    "You are a focused PiForge sub-agent. Work independently on the task you are given.",
    "You have only read-only tools: read, grep, find, ls. You cannot edit files, run shell commands, or ask follow-up questions.",
    "Investigate thoroughly but stay on task. When finished, answer with a concise, self-contained report",
    "(findings, file paths with line numbers, and a recommendation) that the parent agent can use directly.",
    `Working directory: ${cwd}`,
  ].join("\n");
}

export interface SpawnSubagentInput {
  name: string;
  task: string;
  cwd: string;
  parentSessionId: string;
  model?: Model<string>;
  thinkingLevel?: ThinkingLevel;
  signal?: AbortSignal;
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
  if (runningCount() >= MAX_RUNNING) {
    throw new SubagentError(
      `Too many sub-agents are already running (limit ${MAX_RUNNING}). Wait for one to finish or split the work into fewer tasks.`,
    );
  }
  pruneFinished();

  const id = `subagent-${randomUUID().slice(0, 12)}`;
  const abort = new AbortController();
  const record: SubagentRecord = {
    view: {
      id,
      name,
      task,
      parentSessionId: input.parentSessionId,
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
    const resourceLoader = new DefaultResourceLoader({
      cwd: input.cwd,
      agentDir,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: childSystemPrompt(input.cwd),
    });
    await resourceLoader.reload();

    const runtime = await getSharedAuxRuntime();
    const { session } = await createAgentSession({
      cwd: input.cwd,
      agentDir,
      modelRuntime: runtime,
      sessionManager: SessionManager.inMemory(input.cwd),
      resourceLoader,
      ...(input.model ? { model: input.model } : {}),
      ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
      tools: READ_ONLY_TOOLS,
    });
    record.session = session;

    unsubscribe = session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
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
        const call: SubagentToolCallView = {
          id: event.toolCallId,
          name: event.toolName,
          status: "running",
          startedAt: Date.now(),
          endedAt: null,
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
      record.view.error = record.timedOut
        ? `Timed out after ${Math.round(SUBAGENT_TIMEOUT_MS / 60_000)} minutes`
        : "Cancelled";
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
    notify({ type: "subagent_finished", agent: snapshotView(record), timestamp: Date.now() });
  }

  const agent = snapshotView(record);
  if (ok) {
    return {
      agent,
      ok: true,
      text: `Sub-agent "${name}" completed.

${finalText || "(no text output)"}`,
    };
  }
  const reason = record.view.error ?? "unknown error";
  return {
    agent,
    ok: false,
    text: `Sub-agent "${name}" ${record.view.status === "cancelled" ? (record.timedOut ? "timed out" : "was cancelled") : `failed: ${reason}`}.`,
    error: reason,
  };
}
