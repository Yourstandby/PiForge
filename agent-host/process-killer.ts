/**
 * Bounded process-tree termination + identity verification.
 *
 * This is the seam for future platform hardening:
 *   - today: POSIX process groups (`kill(-pgid)`) / Windows `taskkill /T /F`
 *   - future: Windows Job Objects or a small Rust helper can implement
 *     `ProcessTerminator` / `ProcessIdentityVerifier` and be swapped in via
 *     `setProcessTerminator()` without touching the process state machine.
 *
 * This is lifecycle control, not a security sandbox.
 */
import { execFile } from "node:child_process";
import type { ManagedProcessRecord } from "../contract/domains/processes.ts";

export interface TerminateOptions {
  pid: number;
  /** POSIX process-group id (leader pid). Ignored on Windows. */
  pgid?: number | null;
  /** Skip the graceful phase (force stop). */
  force?: boolean;
  /** Wait after SIGTERM before SIGKILL. Default 2500ms. */
  gracefulMs?: number;
  /** Wait after SIGKILL / taskkill for the tree to disappear. Default 2500ms. */
  timeoutMs?: number;
  /** Bounded retries for the force phase. Default 2. */
  retries?: number;
}

export interface TerminateResult {
  ok: boolean;
  /** Which mechanism ran: "process-group" | "taskkill" | "child". */
  strategy: string;
  attempts: number;
  forced: boolean;
  error?: string;
}

export interface ProcessTerminator {
  readonly name: string;
  terminate(options: TerminateOptions): Promise<TerminateResult>;
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

export interface ProcessIdentityVerifier {
  readonly name: string;
  verify(record: ManagedProcessRecord): Promise<VerifyResult>;
}

const DEFAULT_GRACEFUL_MS = 2_500;
const DEFAULT_TIMEOUT_MS = 2_500;
const DEFAULT_RETRIES = 2;
const RETRY_DELAY_MS = 200;

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

function run(command: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 256 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          ...(error ? { error: (error as Error).message } : {}),
        });
      },
    );
  });
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export function isGroupAlive(pgid: number): boolean {
  if (!Number.isFinite(pgid) || pgid <= 0) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntilGone(
  check: () => boolean,
  timeoutMs: number,
  intervalMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!check()) return true;
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
  return !check();
}

async function windowsTaskAlive(pid: number): Promise<boolean> {
  const result = await run("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], 5_000);
  if (!result.ok) return isPidAlive(pid);
  // "INFO: No tasks are running..." when absent; CSV when present.
  return result.stdout.includes(`"${pid}"`) || result.stdout.includes(`,${pid},`);
}

async function terminatePosix(options: TerminateOptions): Promise<TerminateResult> {
  const { pid, pgid, force = false } = options;
  const gracefulMs = force ? 0 : (options.gracefulMs ?? DEFAULT_GRACEFUL_MS);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = Math.max(1, options.retries ?? DEFAULT_RETRIES);
  const target = pgid && pgid > 0 ? -pgid : pid;
  const strategy = target < 0 ? "process-group" : "child";
  const alive = () => (target < 0 ? isGroupAlive(-target) : isPidAlive(target));
  let attempts = 0;
  let error: string | undefined;

  if (gracefulMs > 0) {
    try {
      process.kill(target, "SIGTERM");
    } catch (err) {
      error = (err as Error).message;
    }
    if (await waitUntilGone(alive, gracefulMs)) {
      return { ok: true, strategy, attempts: 1, forced: false };
    }
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    attempts += 1;
    try {
      process.kill(target, "SIGKILL");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ESRCH") {
        return { ok: true, strategy, attempts, forced: true };
      }
      error = (err as Error).message;
    }
    if (await waitUntilGone(alive, timeoutMs)) {
      return { ok: true, strategy, attempts, forced: true };
    }
    if (attempt < retries) await sleep(RETRY_DELAY_MS);
  }
  return {
    ok: false,
    strategy,
    attempts,
    forced: true,
    error: error ?? "process tree is still alive after SIGKILL",
  };
}

async function terminateWindows(options: TerminateOptions): Promise<TerminateResult> {
  const { pid } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = Math.max(1, options.retries ?? DEFAULT_RETRIES);
  let attempts = 0;
  let error: string | undefined;

  for (let attempt = 1; attempt <= retries; attempt++) {
    attempts += 1;
    const result = await run("taskkill", ["/PID", String(pid), "/T", "/F"], timeoutMs);
    if (!result.ok) {
      error = (result.stderr || result.error || "taskkill failed").trim().slice(0, 500);
      // "not found" means the tree is already gone.
      if (/not found|no running instance/i.test(error)) {
        return { ok: true, strategy: "taskkill", attempts, forced: true };
      }
    }
    if (!(await windowsTaskAlive(pid))) {
      return { ok: true, strategy: "taskkill", attempts, forced: true };
    }
    if (attempt < retries) await sleep(RETRY_DELAY_MS);
  }

  // Last-resort Node TerminateProcess (does not guarantee the whole tree, so
  // only report success when the leader is gone *and* taskkill succeeded).
  try {
    process.kill(pid, "SIGKILL");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ESRCH") return { ok: true, strategy: "taskkill", attempts, forced: true };
    error = (err as Error).message;
  }
  if (!(await windowsTaskAlive(pid))) {
    return { ok: true, strategy: "taskkill", attempts, forced: true };
  }
  return {
    ok: false,
    strategy: "taskkill",
    attempts,
    forced: true,
    error: error ?? "process still alive after taskkill",
  };
}

export async function terminateProcessTree(
  options: TerminateOptions,
  terminator: ProcessTerminator = nodeProcessTerminator,
): Promise<TerminateResult> {
  if (!Number.isFinite(options.pid) || options.pid <= 0) {
    return { ok: true, strategy: "none", attempts: 0, forced: false };
  }
  return terminator.terminate(options);
}

/** Node implementation: process groups on POSIX, taskkill /T on Windows. */
export const nodeProcessTerminator: ProcessTerminator = {
  name: "node",
  terminate(options) {
    return process.platform === "win32"
      ? terminateWindows(options)
      : terminatePosix(options);
  },
};

let activeTerminator: ProcessTerminator = nodeProcessTerminator;

/** Swap in a Job Object / Rust helper later; the state machine is unchanged. */
export function setProcessTerminator(terminator: ProcessTerminator): void {
  activeTerminator = terminator;
}

export function getProcessTerminator(): ProcessTerminator {
  return activeTerminator;
}

function firstToken(command: string): string {
  const trimmed = command.trim();
  const match = /^"[^"]+"|^\S+/.exec(trimmed);
  return (match?.[0] ?? trimmed).replace(/^"|"$/g, "").split(/[\/]/).pop() ?? trimmed;
}

async function verifyPosix(record: ManagedProcessRecord): Promise<VerifyResult> {
  if (!record.pid || !isPidAlive(record.pid)) {
    return { ok: false, reason: "pid is not running" };
  }
  const pgidResult = await run("ps", ["-o", "pgid=", "-p", String(record.pid)], 4_000);
  if (!pgidResult.ok) return { ok: false, reason: "ps pgid lookup failed" };
  const actualPgid = Number(pgidResult.stdout.trim());
  if (!Number.isFinite(actualPgid) || actualPgid <= 0) {
    return { ok: false, reason: "pgid is unknown" };
  }
  if (record.pgid !== null && actualPgid !== record.pgid) {
    return { ok: false, reason: `pgid mismatch (${actualPgid} != ${record.pgid})` };
  }
  const argsResult = await run("ps", ["-o", "args=", "-p", String(record.pid)], 4_000);
  if (!argsResult.ok) return { ok: false, reason: "ps command lookup failed" };
  if (!argsResult.stdout.includes(firstToken(record.command))) {
    return { ok: false, reason: "command line does not match the recorded command" };
  }
  return { ok: true };
}

async function verifyWindows(record: ManagedProcessRecord): Promise<VerifyResult> {
  if (!record.pid) return { ok: false, reason: "pid is missing" };
  const ps = await run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${record.pid}"; if ($p) { "ALIVE"; $p.CommandLine }`,
    ],
    6_000,
  );
  if (!ps.ok || !ps.stdout.includes("ALIVE")) {
    return { ok: false, reason: "process is not running" };
  }
  if (!ps.stdout.includes(firstToken(record.command))) {
    return { ok: false, reason: "command line does not match the recorded command" };
  }
  return { ok: true };
}

/**
 * Verify that a persisted record still describes the process we started.
 * Fails closed: an unreadable tool, missing pid, or mismatched command line
 * means "do not kill".
 */
export const nodeIdentityVerifier: ProcessIdentityVerifier = {
  name: "node",
  verify(record) {
    return process.platform === "win32" ? verifyWindows(record) : verifyPosix(record);
  },
};

export function firstCommandToken(command: string): string {
  return firstToken(command);
}
