/**
 * Managed background processes (`run_bg`, dev servers, watchers).
 *
 * Owned by the Agent Host. Next.js only proxies RPC calls and SSE events.
 *
 * This is **lifecycle control, not a security sandbox**: it tracks ownership,
 * readiness and exit semantics, bounds cleanup of the process trees it started,
 * and leaves a persisted record for crash recovery. A process that fully
 * detaches (double-fork/setsid/service manager) can still escape.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type {
  ManagedProcessCleanup,
  ManagedProcessEndpoint,
  ManagedProcessExitReason,
  ManagedProcessOwner,
  ManagedProcessReadiness,
  ManagedProcessStatus,
  ManagedProcessView,
} from "../contract/domains/processes.ts";
import {
  assertTransition,
  canRestart,
  isTerminalStatus,
  statusAfterExit,
} from "./process-state.ts";
import { getProcessTerminator } from "./process-killer.ts";
import {
  removeProcessRecord,
  upsertProcessRecord,
} from "./process-instance-store.ts";

interface ManagedProcessEntry {
  id: string;
  name: string;
  command: string;
  cwd: string;
  owner: ManagedProcessOwner;
  status: ManagedProcessStatus;
  readiness: ManagedProcessReadiness;
  exitReason: ManagedProcessExitReason | null;
  endpoint: ManagedProcessEndpoint | null;
  pid: number | null;
  pgid: number | null;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  signal: string | null;
  restartCount: number;
  cleanup: ManagedProcessCleanup | null;
  logs: string[];
  /** Absolute index of the first line still kept in `logs`. */
  logsBaseIndex: number;
  /** Total lines ever observed. */
  logLineCount: number;
  child: ChildProcess | null;
}

const MAX_LOG_LINES = 400;
const MAX_LOG_BYTES = 128 * 1024;
const MAX_COMMAND_LENGTH = 2000;
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?[^\s"'<>]*/i;
const READY_RE = /(ready in|listening on|started server|server running|local:\s*http|compiled successfully|now listening)/i;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(sk-[A-Za-z0-9_-]{6,})/g, "sk-[redacted]"],
  [/\b(gh[pousr]_[A-Za-z0-9]{10,})/g, "[redacted-token]"],
  [/\b(AKIA[0-9A-Z]{12,})/g, "[redacted-aws-key]"],
  [/(authorization\s*:\s*bearer\s+)[^\s]+/gi, "$1[redacted]"],
  [/(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[redacted]"],
  [/((?:token|api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[redacted]"],
];

let homeDir = "";
try {
  homeDir = homedir();
} catch {
  homeDir = "";
}

/** Remove credentials and the user's home path before logs reach the renderer. */
export function sanitizeLogLine(line: string): string {
  let output = line;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  if (homeDir) {
    output = output.split(homeDir).join("~");
  }
  // Generic user-home shapes (including other users on shared machines).
  output = output
    .replace(/[A-Za-z]:\\Users\\[^\\\s"'<>]+/g, "~")
    .replace(/\/(?:home|Users)\/[^/\s"'<>]+/g, "~");
  return output.slice(0, 4000);
}

// A single registry lives in the host process; there is no HMR inside the
// utility process, so plain module state is enough.
const registry = new Map<string, ManagedProcessEntry>();
const listeners = new Set<() => void>();

/** Subscribe to list/log changes (used by the host event broadcaster). */
export function onManagedProcessesChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyChange(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.error("managed-process listener failed:", error);
    }
  }
}

function parseEndpoint(url: string): ManagedProcessEndpoint | null {
  try {
    const parsed = new URL(url);
    const port = parsed.port
      ? Number(parsed.port)
      : parsed.protocol === "https:"
        ? 443
        : 80;
    return { url, host: parsed.hostname, port };
  } catch {
    return null;
  }
}

function trimLogs(entry: ManagedProcessEntry): void {
  while (entry.logs.length > MAX_LOG_LINES) entry.logs.shift();
  while (
    entry.logs.length > 1 &&
    Buffer.byteLength(entry.logs.join("\n"), "utf8") > MAX_LOG_BYTES
  ) {
    entry.logs.shift();
  }
  entry.logsBaseIndex = Math.max(0, entry.logLineCount - entry.logs.length);
}

function pushLog(entry: ManagedProcessEntry, chunk: string): void {
  const lines = chunk.split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    const safeLine = sanitizeLogLine(line);
    entry.logs.push(safeLine);
    entry.logLineCount += 1;
    if (!entry.endpoint) {
      const match = safeLine.match(URL_RE);
      if (match) entry.endpoint = parseEndpoint(match[0]);
    }
    if (entry.readiness === "pending" && READY_RE.test(safeLine)) {
      entry.readiness = "ready";
    }
  }
  trimLogs(entry);
  notifyChange();
}

function toView(entry: ManagedProcessEntry): ManagedProcessView {
  const endedAt = entry.endedAt;
  return {
    id: entry.id,
    name: entry.name,
    command: entry.command,
    cwd: entry.cwd,
    owner: entry.owner,
    status: entry.status,
    readiness: entry.readiness,
    exitReason: entry.exitReason,
    ready: entry.readiness === "ready",
    endpoint: entry.endpoint,
    url: entry.endpoint?.url ?? null,
    pid: entry.pid,
    startedAt: entry.startedAt,
    endedAt,
    durationMs: Math.max(0, (endedAt ?? Date.now()) - entry.startedAt),
    exitCode: entry.exitCode,
    signal: entry.signal,
    restartCount: entry.restartCount,
    logs: entry.logs.slice(-80),
    logLineCount: entry.logLineCount,
    cleanup: entry.cleanup,
  };
}

function defaultName(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? "process";
  const base = first.replace(/\\/g, "/").split("/").pop() ?? first;
  return base.slice(0, 40) || "process";
}

export function listManagedProcesses(): ManagedProcessView[] {
  return [...registry.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(toView);
}

/** Single-process snapshot for the read/wait tools. */
export function getManagedProcess(id: string): ManagedProcessView | null {
  const entry = registry.get(id);
  return entry ? toView(entry) : null;
}

export interface StartManagedProcessOptions {
  cwd: string;
  command: string;
  name?: string;
  /** Who started it; controls crash-reaper eligibility. Default "user". */
  owner?: ManagedProcessOwner;
}

function transition(entry: ManagedProcessEntry, to: ManagedProcessStatus): void {
  if (entry.status === to) return;
  assertTransition(entry.status, to);
  entry.status = to;
}

function markReadyFailedIfPending(entry: ManagedProcessEntry): void {
  if (entry.readiness === "pending") entry.readiness = "failed";
}

function persistRecord(entry: ManagedProcessEntry): void {
  if (!entry.pid) return;
  upsertProcessRecord({
    id: entry.id,
    owner: entry.owner,
    name: entry.name,
    command: entry.command,
    cwd: entry.cwd,
    pid: entry.pid,
    pgid: entry.pgid,
    startedAt: entry.startedAt,
  });
}

function spawnChild(entry: ManagedProcessEntry): void {
  const child = spawn(entry.command, {
    cwd: entry.cwd,
    shell: true,
    windowsHide: true,
    // POSIX: detached puts the child in its own process group so cleanup can
    // signal the whole tree (`kill(-pgid)`). Windows uses taskkill /T instead.
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
  });
  entry.child = child;
  entry.pid = child.pid ?? null;
  entry.pgid = process.platform === "win32" ? null : (child.pid ?? null);

  // Handlers can fire after a restart replaced this child; ignore stale ones.
  const isCurrent = () => entry.child === child;

  child.on("spawn", () => {
    if (!isCurrent()) return;
    // A stop can land before the first spawn event; never revive it to running.
    if (entry.status === "starting") transition(entry, "running");
    persistRecord(entry);
    notifyChange();
  });
  child.stdout?.on("data", (data: Buffer | string) => {
    if (!isCurrent()) return;
    pushLog(entry, data.toString());
  });
  child.stderr?.on("data", (data: Buffer | string) => {
    if (!isCurrent()) return;
    pushLog(entry, data.toString());
  });
  child.on("error", (error) => {
    if (!isCurrent()) return;
    if (!isTerminalStatus(entry.status)) {
      markReadyFailedIfPending(entry);
      transition(entry, "crashed");
      entry.exitReason = "crashed";
    }
    entry.endedAt ??= Date.now();
    entry.cleanup ??= null;
    entry.child = null;
    pushLog(entry, `[error] ${error.message}`);
    removeProcessRecord(entry.id);
    notifyChange();
  });
  child.on("exit", (code, signal) => {
    if (!isCurrent()) return;
    entry.exitCode = code;
    entry.signal = signal;
    if (entry.status === "stopping") {
      transition(entry, "stopped");
      entry.exitReason = "stopped";
    } else if (!isTerminalStatus(entry.status)) {
      const next = statusAfterExit(entry.status, code, signal);
      transition(entry, next.status);
      entry.exitReason = next.exitReason;
    }
    entry.endedAt ??= Date.now();
    markReadyFailedIfPending(entry);
    entry.child = null;
    entry.pid = null;
    pushLog(entry, `[exit] code=${code ?? "null"} signal=${signal ?? "none"}`);
    removeProcessRecord(entry.id);
    notifyChange();
  });
}

/**
 * Start a managed process. The returned view is usually `starting`; the UI
 * updates to `running` through the `processes` event stream.
 */
export function startManagedProcess(
  options: StartManagedProcessOptions,
): ManagedProcessView {
  const command = options.command.trim();
  if (!command) throw new Error("Command is required");
  if (command.length > MAX_COMMAND_LENGTH) throw new Error("Command is too long");

  const entry: ManagedProcessEntry = {
    id: randomUUID(),
    name: options.name?.trim() || defaultName(command),
    command,
    cwd: options.cwd,
    owner: options.owner ?? "user",
    status: "starting",
    readiness: "pending",
    exitReason: null,
    endpoint: null,
    pid: null,
    pgid: null,
    startedAt: Date.now(),
    endedAt: null,
    exitCode: null,
    signal: null,
    restartCount: 0,
    cleanup: null,
    logs: [],
    logsBaseIndex: 0,
    logLineCount: 0,
    child: null,
  };

  registry.set(entry.id, entry);
  try {
    spawnChild(entry);
  } catch (error) {
    transition(entry, "crashed");
    entry.exitReason = "crashed";
    entry.readiness = "failed";
    entry.endedAt = Date.now();
    const message = error instanceof Error ? error.message : String(error);
    pushLog(entry, `[error] ${message}`);
  }
  notifyChange();
  return toView(entry);
}

/** Send one line to the process stdin (REPLs, interactive dev servers). */
export function sendManagedProcessInput(id: string, input: string): boolean {
  const entry = registry.get(id);
  if (!entry || entry.status !== "running" || !entry.child?.stdin?.writable) return false;
  try {
    entry.child.stdin.write(input.endsWith("\n") ? input : input + "\n");
    pushLog(entry, `> ${input}`);
    return true;
  } catch {
    return false;
  }
}

export interface StopManagedProcessOptions {
  /** Skip the graceful SIGTERM phase. */
  force?: boolean;
}

/**
 * Stop a managed process. A requested stop always ends in `stopped` (never a
 * crash) and does not fire completion notifications; a failed cleanup is kept
 * in `cleanup.ok = false` + `exitReason = "cleanup-failed"` and logged.
 */
export async function stopManagedProcess(
  id: string,
  options: StopManagedProcessOptions = {},
): Promise<boolean> {
  const entry = registry.get(id);
  if (!entry) return false;
  // A failed cleanup leaves the process in a terminal state while the tree may
  // still be alive; allow a later stop/force-stop to retry instead of lying.
  const retryFailedCleanup = entry.cleanup?.ok === false;
  if (isTerminalStatus(entry.status) && !retryFailedCleanup) return true;
  if (entry.status === "starting" || entry.status === "running") {
    transition(entry, "stopping");
  }
  pushLog(entry, `[desktop] ${options.force ? "force stopping" : "stopping"}…`);

  if (!entry.pid) {
    transition(entry, "stopped");
    entry.exitReason = "stopped";
    entry.endedAt ??= Date.now();
    markReadyFailedIfPending(entry);
    removeProcessRecord(entry.id);
    notifyChange();
    return true;
  }

  const attemptedAt = Date.now();
  const result = await getProcessTerminator().terminate({
    pid: entry.pid,
    pgid: entry.pgid,
    force: options.force === true,
    gracefulMs: options.force ? 0 : 2_500,
    timeoutMs: 2_500,
    retries: 2,
  });
  entry.cleanup = {
    attemptedAt,
    ok: result.ok,
    strategy: result.strategy,
    attempts: result.attempts,
    forced: result.forced,
    ...(result.error ? { error: result.error } : {}),
  };

  if (!isTerminalStatus(entry.status)) {
    transition(entry, "stopped");
  }
  entry.exitReason = result.ok ? "stopped" : "cleanup-failed";
  if (result.ok) entry.endedAt ??= Date.now();
  entry.endedAt ??= Date.now();
  markReadyFailedIfPending(entry);
  if (!result.ok) {
    pushLog(entry, `[cleanup] failed after ${result.attempts} attempt(s): ${result.error ?? "unknown"}`);
  } else {
    // The terminator verified the tree is gone; drop the persisted record now
    // instead of waiting for the exit event.
    removeProcessRecord(entry.id);
  }
  notifyChange();
  return true;
}

export async function forceStopManagedProcess(id: string): Promise<boolean> {
  return stopManagedProcess(id, { force: true });
}

/**
 * Restart keeps the process id and log history, resets the run state and
 * increments `restartCount`. The previous run must stop cleanly enough to be
 * terminal first; a failed cleanup aborts the restart (fail-closed).
 */
export async function restartManagedProcess(id: string): Promise<ManagedProcessView | null> {
  const entry = registry.get(id);
  if (!entry) return null;
  if (!isTerminalStatus(entry.status)) {
    await stopManagedProcess(id, { force: true });
  }
  if (!isTerminalStatus(entry.status) || !canRestart(entry.status)) return null;

  entry.status = "starting";
  entry.readiness = "pending";
  entry.exitReason = null;
  entry.endpoint = null;
  entry.pid = null;
  entry.pgid = null;
  entry.startedAt = Date.now();
  entry.endedAt = null;
  entry.exitCode = null;
  entry.signal = null;
  entry.cleanup = null;
  entry.restartCount += 1;
  entry.logs.push("--- restarted ---");
  entry.logLineCount += 1;
  trimLogs(entry);

  try {
    spawnChild(entry);
  } catch (error) {
    transition(entry, "crashed");
    entry.exitReason = "crashed";
    entry.readiness = "failed";
    entry.endedAt = Date.now();
    pushLog(entry, `[error] ${error instanceof Error ? error.message : String(error)}`);
  }
  notifyChange();
  return toView(entry);
}

export async function removeManagedProcessEntry(id: string): Promise<boolean> {
  const entry = registry.get(id);
  if (!entry) return false;
  if (!isTerminalStatus(entry.status)) await stopManagedProcess(id, { force: true });
  removeProcessRecord(id);
  const removed = registry.delete(id);
  if (removed) notifyChange();
  return removed;
}

export interface ManagedProcessLogPage {
  id: string;
  lines: string[];
  /** Absolute index of the first returned line. */
  cursor: number;
  /** Pass to the next call to continue after these lines. */
  nextCursor: number;
  totalLines: number;
}

/**
 * Read logs from an absolute cursor. Slow-start services can poll with the
 * returned `nextCursor` instead of re-reading the ring buffer from the start.
 */
export function readManagedProcessLogs(
  id: string,
  options: { cursor?: number; limit?: number } = {},
): ManagedProcessLogPage | null {
  const entry = registry.get(id);
  if (!entry) return null;
  const limit = Math.min(500, Math.max(1, Math.floor(options.limit ?? 200)));
  const requested = Math.max(0, Math.floor(options.cursor ?? entry.logsBaseIndex));
  const cursor = Math.max(requested, entry.logsBaseIndex);
  const offset = cursor - entry.logsBaseIndex;
  const lines = entry.logs.slice(offset, offset + limit);
  return {
    id,
    lines,
    cursor,
    nextCursor: cursor + lines.length,
    totalLines: entry.logLineCount,
  };
}

/**
 * Stop every live child before the host exits. Failures are logged (never
 * silently swallowed); the count is the number of processes we attempted.
 */
export async function stopAllManagedProcesses(): Promise<number> {
  const live = [...registry.values()].filter(
    (entry) => !isTerminalStatus(entry.status) || entry.cleanup?.ok === false,
  );
  await Promise.all(
    live.map(async (entry) => {
      await stopManagedProcess(entry.id, { force: true });
      if (entry.cleanup && !entry.cleanup.ok) {
        console.error(
          `managed-process: cleanup failed for ${entry.name} (${entry.id}): ${entry.cleanup.error ?? "unknown"}`,
        );
      }
    }),
  );
  return live.length;
}

/** True when at least one cleanup failed and the tree may still be alive. */
export function hasFailedProcessCleanup(): boolean {
  return [...registry.values()].some((entry) => entry.cleanup?.ok === false);
}

/** Test helper: drop all state and kill any live children. */
export async function resetManagedProcessesForTest(): Promise<void> {
  await stopAllManagedProcesses();
  registry.clear();
  listeners.clear();
}
