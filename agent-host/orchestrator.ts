/**
 * Process-isolated Session Orchestrator (v0.7.0 module 3).
 *
 * Each task gets:
 *   - a real Git worktree created by the existing ownership-marked helper,
 *   - a separate OS worker process (`orchestrator-worker.js`) running one
 *     AgentSession in that worktree,
 *   - a JSON-lines result channel back to the Host.
 *
 * The Host never shares its AgentSession with a worker. The worker can edit
 * only its own worktree; the parent session keeps the repository root.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "./sdk-adapter.ts";
import type {
  OrchestratorSpawnInput,
  OrchestratorTaskView,
} from "../contract/domains/orchestrator.ts";
import type { SubagentToolCallView } from "../contract/domains/subagents.ts";
import type { ManagedProcessStatus } from "../contract/domains/processes.ts";
import { withGitWorktree, type GitWorktreeResult } from "../lib/git-worktree.ts";
import { addAllowedRoot, authorizePath } from "./allowed-roots.ts";
import { assertTransition, isTerminalStatus, statusAfterExit } from "./process-state.ts";
import { terminateProcessTree } from "./process-killer.ts";
import type {
  OrchestratorWorkerConfig,
  OrchestratorWorkerMessage,
} from "./orchestrator-protocol.ts";

const MAX_WORKERS = 4;
const MAX_RETAINED = 20;
const MAX_OUTPUT_CHARS = 40_000;
const WORKER_TIMEOUT_MS = 30 * 60_000;

export interface WorkerHandle {
  pid: number | null;
  /** Request termination of the whole worker tree. */
  kill: () => void;
}

export interface WorkerLaunchHandlers {
  onMessage: (message: OrchestratorWorkerMessage) => void;
  onExit: (code: number | null, signal: string | null) => void;
  onError: (error: Error) => void;
}

export type LaunchOrchestratorWorker = (
  config: OrchestratorWorkerConfig,
  handlers: WorkerLaunchHandlers,
) => WorkerHandle;

export interface OrchestratorDependencies {
  authorizeTarget?: (target: string) => Promise<string>;
  createWorktree?: <T>(
    options: { sourceCwd: string; targetCwd: string; branchName?: string },
    operation: (worktree: GitWorktreeResult) => T | Promise<T>,
  ) => Promise<T>;
  launchWorker?: LaunchOrchestratorWorker;
  /** Test-only root for config files / scratch worktrees. */
  worktreeRoot?: string;
}

interface TaskRecord {
  view: OrchestratorTaskView;
  handle: WorkerHandle | null;
  timer: ReturnType<typeof setTimeout> | null;
}

const records = new Map<string, TaskRecord>();
const listeners = new Set<(task: OrchestratorTaskView) => void>();

export class OrchestratorError extends Error {
  readonly code: "E_INVALID_PARAMS" | "E_LIMIT" | "E_WORKTREE" | "E_WORKER";

  constructor(code: OrchestratorError["code"], message: string) {
    super(message);
    this.name = "OrchestratorError";
    this.code = code;
  }
}

export function onOrchestratorChange(listener: (task: OrchestratorTaskView) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(record: TaskRecord): void {
  const snapshot = snapshotView(record);
  for (const listener of [...listeners]) {
    try {
      listener(snapshot);
    } catch (error) {
      console.error("orchestrator listener failed:", error);
    }
  }
}

function snapshotView(record: TaskRecord): OrchestratorTaskView {
  const view = record.view;
  return {
    ...view,
    durationMs: Math.max(0, (view.finishedAt ?? Date.now()) - view.startedAt),
    toolCalls: view.toolCalls.map((call) => ({ ...call })),
    filesChanged: [...view.filesChanged],
    verification: { ...view.verification, evidence: [...view.verification.evidence] },
  };
}

export function listOrchestratorTasks(): OrchestratorTaskView[] {
  return [...records.values()]
    .map(snapshotView)
    .sort((a, b) => a.startedAt - b.startedAt);
}

export function getOrchestratorTask(id: string): OrchestratorTaskView | null {
  const record = records.get(id);
  return record ? snapshotView(record) : null;
}

function setStatus(record: TaskRecord, next: ManagedProcessStatus): void {
  if (record.view.status === next) return;
  assertTransition(record.view.status, next);
  record.view.status = next;
  if (isTerminalStatus(next)) {
    record.view.finishedAt ??= Date.now();
    record.view.activity = "idle";
    if (record.timer) clearTimeout(record.timer);
    record.timer = null;
  }
}

function activeCount(): number {
  return [...records.values()].filter((record) => !isTerminalStatus(record.view.status)).length;
}

function pruneFinished(): void {
  const finished = [...records.values()]
    .filter((record) => isTerminalStatus(record.view.status))
    .sort((a, b) => (a.view.finishedAt ?? 0) - (b.view.finishedAt ?? 0));
  while (finished.length > MAX_RETAINED) {
    const oldest = finished.shift();
    if (oldest) records.delete(oldest.view.id);
  }
}

function appendOutput(record: TaskRecord, text: string): void {
  const clean = text.trim();
  if (!clean) return;
  const combined = record.view.output ? `${record.view.output}\n\n${clean}` : clean;
  record.view.output = combined.length > MAX_OUTPUT_CHARS
    ? `…${combined.slice(-MAX_OUTPUT_CHARS)}`
    : combined;
}

function updateTool(record: TaskRecord, call: SubagentToolCallView): void {
  const existing = record.view.toolCalls.find((item) => item.id === call.id);
  if (existing) Object.assign(existing, call);
  else record.view.toolCalls.push({ ...call });
}

function finish(record: TaskRecord, message: Extract<OrchestratorWorkerMessage, { type: "finished" }>): void {
  if (message.output.trim()) record.view.output = message.output;
  else appendOutput(record, message.output);
  record.view.toolCalls = message.toolCalls.map((call) => ({ ...call }));
  record.view.filesChanged = [...message.filesChanged];
  record.view.verified = message.verification.verified;
  record.view.verification = {
    ...message.verification,
    evidence: [...message.verification.evidence],
  };
  if (!message.ok) {
    record.view.error = message.error ?? "worker reported failure";
    if (!isTerminalStatus(record.view.status)) setStatus(record, "crashed");
  } else if (!isTerminalStatus(record.view.status)) {
    setStatus(record, "exited");
  }
  pruneFinished();
  notify(record);
}

function defaultWorktreeRoot(): string {
  return join(homedir(), ".pi", "orchestrator-worktrees");
}

function defaultLaunch(config: OrchestratorWorkerConfig, handlers: WorkerLaunchHandlers): WorkerHandle {
  const runDir = join(getAgentDir(), "orchestrator");
  mkdirSync(runDir, { recursive: true });
  const configPath = join(runDir, `${config.taskId}.json`);
  writeFileSync(configPath, JSON.stringify(config), { encoding: "utf8", mode: 0o600 });
  const workerEntry = fileURLToPath(new URL("./orchestrator-worker.js", import.meta.url));
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [workerEntry], {
      cwd: config.cwd,
      env: {
        ...process.env,
        // In the packaged app process.execPath is PiForge.exe; this makes it
        // behave as Node for the worker entry (same contract as the Host).
        ELECTRON_RUN_AS_NODE: "1",
        PIFORGE_ORCHESTRATOR_CONFIG_PATH: configPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
  } catch (error) {
    rmSync(configPath, { force: true });
    throw error;
  }

  let buffer = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        try {
          handlers.onMessage(JSON.parse(line) as OrchestratorWorkerMessage);
        } catch {
          handlers.onMessage({ type: "progress", text: line.slice(0, 2_000) });
        }
      }
      index = buffer.indexOf("\n");
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    const text = chunk.trim();
    if (text) handlers.onMessage({ type: "progress", text: `[stderr] ${text.slice(0, 2_000)}` });
  });
  child.once("error", (error) => handlers.onError(error));
  child.once("exit", (code, signal) => {
    rmSync(configPath, { force: true });
    void terminateProcessTree({ pid: child.pid ?? 0, force: true }).catch(() => undefined);
    handlers.onExit(code, signal);
  });
  return {
    pid: child.pid ?? null,
    kill: () => {
      if (child.pid) {
        void terminateProcessTree({ pid: child.pid, force: false }).catch(() => child.kill());
      }
    },
  };
}

export async function spawnOrchestratorTask(
  input: OrchestratorSpawnInput,
  deps: OrchestratorDependencies = {},
): Promise<OrchestratorTaskView> {
  if (!input.cwd?.trim()) throw new OrchestratorError("E_INVALID_PARAMS", "cwd is required");
  if (!input.task?.trim()) throw new OrchestratorError("E_INVALID_PARAMS", "task is required");
  if (!input.parentSessionId?.trim()) throw new OrchestratorError("E_INVALID_PARAMS", "parentSessionId is required");
  if (activeCount() >= MAX_WORKERS) {
    throw new OrchestratorError("E_LIMIT", `At most ${MAX_WORKERS} workers can run at once`);
  }

  const id = randomUUID();
  const root = deps.worktreeRoot ?? defaultWorktreeRoot();
  const target = input.targetCwd?.trim()
    ? input.targetCwd.trim()
    : join(root, `${basename(input.cwd)}-${id.slice(0, 8)}`);
  const authorize = deps.authorizeTarget ?? (async (path) => {
    // The default scratch root is Host-owned; register it so the normal file
    // policy applies to the new worktree without widening to the repository
    // parent. A caller-provided target still has to pass the normal policy.
    if (!input.targetCwd?.trim()) {
      mkdirSync(root, { recursive: true });
      addAllowedRoot(root);
    }
    return authorizePath(path, "write");
  });
  const createWorktree = deps.createWorktree ?? withGitWorktree;
  const launch = deps.launchWorker ?? defaultLaunch;

  const record: TaskRecord = {
    view: {
      id,
      name: input.name?.trim() || `worker-${id.slice(0, 6)}`,
      task: input.task.trim(),
      parentSessionId: input.parentSessionId,
      parentTaskId: input.parentTaskId?.trim() || null,
      status: "starting",
      activity: "working",
      cwd: target,
      branchName: input.branchName?.trim() || `piforge/orchestrator-${id.slice(0, 8)}`,
      repoRoot: null,
      workerPid: null,
      startedAt: Date.now(),
      finishedAt: null,
      durationMs: 0,
      verified: false,
      output: "",
      toolCalls: [],
      filesChanged: [],
      verification: { verified: false, reason: "waiting for worker", evidence: [], checkedAt: Date.now() },
    },
    handle: null,
    timer: null,
  };
  records.set(id, record);

  try {
    const authorized = await authorize(target);
    record.view.cwd = authorized;
    await createWorktree(
      {
        sourceCwd: input.cwd,
        targetCwd: authorized,
        ...(record.view.branchName ? { branchName: record.view.branchName } : {}),
      },
      (worktree) => {
        addAllowedRoot(worktree.cwd);
        record.view.cwd = worktree.cwd;
        record.view.branchName = worktree.branchName;
        record.view.repoRoot = worktree.repoRoot;
        return worktree;
      },
    );

    const config: OrchestratorWorkerConfig = {
      version: 1,
      taskId: id,
      name: record.view.name,
      task: record.view.task,
      cwd: record.view.cwd,
      parentSessionId: record.view.parentSessionId,
      parentTaskId: record.view.parentTaskId,
    };

    record.handle = launch(config, {
      onMessage: (message) => {
        if (message.type === "ready") {
          record.view.workerPid = message.pid;
          if (record.view.status === "starting") setStatus(record, "running");
          notify(record);
          return;
        }
        if (message.type === "progress") {
          appendOutput(record, message.text);
          notify(record);
          return;
        }
        if (message.type === "tool") {
          updateTool(record, message.call);
          notify(record);
          return;
        }
        if (message.type === "finished") {
          finish(record, message);
          return;
        }
        if (message.type === "error") {
          record.view.error = message.message;
          if (!isTerminalStatus(record.view.status)) setStatus(record, "crashed");
          notify(record);
        }
      },
      onExit: (code, signal) => {
        if (isTerminalStatus(record.view.status)) {
          if (record.timer) clearTimeout(record.timer);
          record.timer = null;
          return;
        }
        if (record.view.status === "stopping") {
          setStatus(record, "stopped");
        } else {
          const outcome = statusAfterExit(record.view.status, code, signal);
          setStatus(record, outcome.status);
          if (outcome.status === "crashed") {
            record.view.error ??= `worker exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "none"})`;
          }
        }
        pruneFinished();
        notify(record);
      },
      onError: (error) => {
        record.view.error = error.message;
        if (!isTerminalStatus(record.view.status)) setStatus(record, "crashed");
        notify(record);
      },
    });
    record.view.workerPid = record.handle.pid;
    record.timer = setTimeout(() => {
      record.view.error = "orchestrator worker timed out";
      record.handle?.kill();
      void stopOrchestratorTask(id);
    }, WORKER_TIMEOUT_MS);
    record.timer.unref?.();
    notify(record);
    return snapshotView(record);
  } catch (error) {
    record.view.error = error instanceof Error ? error.message : String(error);
    if (!isTerminalStatus(record.view.status)) {
      try {
        setStatus(record, "crashed");
      } catch {
        // Status may already be terminal.
      }
    }
    notify(record);
    throw new OrchestratorError("E_WORKTREE", `${record.view.error}`);
  }
}

export async function stopOrchestratorTask(id: string): Promise<boolean> {
  const record = records.get(id);
  if (!record) return false;
  if (isTerminalStatus(record.view.status)) return false;
  if (record.view.status === "starting" || record.view.status === "running") {
    setStatus(record, "stopping");
  }
  record.handle?.kill();
  if (!record.handle) setStatus(record, "stopped");
  notify(record);
  return true;
}

export async function stopAllOrchestratorTasks(): Promise<number> {
  const active = [...records.values()].filter((record) => !isTerminalStatus(record.view.status));
  await Promise.all(active.map((record) => stopOrchestratorTask(record.view.id)));
  return active.length;
}

/** Test helper: clear retained records without touching processes. */
export function resetOrchestratorForTest(): void {
  for (const record of records.values()) {
    if (record.timer) clearTimeout(record.timer);
  }
  records.clear();
}
