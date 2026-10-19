import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

/**
 * Tiny managed-process registry for the right-panel "进程" tab.
 *
 * Scope is deliberately small: start a long-running command (dev server,
 * watcher, …) in the project cwd, keep the last chunk of its output, and let
 * the user stop / restart it. No PTY, no stdin, no port allocation.
 *
 * State lives on globalThis so Next.js hot reloads do not orphan children or
 * lose the process list.
 */

export type ManagedProcessStatus = "running" | "exited" | "failed";

export interface ManagedProcessView {
  id: string;
  name: string;
  command: string;
  cwd: string;
  status: ManagedProcessStatus;
  pid: number | null;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  /** First http(s) URL seen in the output — handy for dev servers. */
  url: string | null;
  /** Heuristic readiness: a loopback URL or a "ready/listening" log line. */
  ready: boolean;
  logs: string[];
}

interface ManagedProcessEntry {
  id: string;
  name: string;
  command: string;
  cwd: string;
  status: ManagedProcessStatus;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  url: string | null;
  logs: string[];
  child: ChildProcess | null;
}

declare global {
  var __piManagedProcesses: Map<string, ManagedProcessEntry> | undefined;
}

const MAX_LOG_LINES = 400;
const MAX_COMMAND_LENGTH = 2000;
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?[^\s"'<>]*/i;

function registry(): Map<string, ManagedProcessEntry> {
  if (!globalThis.__piManagedProcesses) globalThis.__piManagedProcesses = new Map();
  return globalThis.__piManagedProcesses;
}

function pushLog(entry: ManagedProcessEntry, chunk: string): void {
  const lines = chunk.split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    entry.logs.push(line);
    if (!entry.url) {
      const match = line.match(URL_RE);
      if (match) entry.url = match[0];
    }
  }
  if (entry.logs.length > MAX_LOG_LINES) {
    entry.logs.splice(0, entry.logs.length - MAX_LOG_LINES);
  }
}

function toView(entry: ManagedProcessEntry): ManagedProcessView {
  return {
    id: entry.id,
    name: entry.name,
    command: entry.command,
    cwd: entry.cwd,
    status: entry.status,
    pid: entry.child?.pid ?? null,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    exitCode: entry.exitCode,
    url: entry.url,
    ready: isReady(entry),
    logs: entry.logs.slice(-80),
  };
}

const READY_RE = /(ready in|listening on|started server|server running|local:\s*http|compiled successfully)/i;

function isReady(entry: ManagedProcessEntry): boolean {
  if (entry.status !== "running") return entry.status === "exited" && entry.exitCode === 0;
  if (entry.url) return true;
  return entry.logs.slice(-20).some((line) => READY_RE.test(line));
}

function defaultName(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? "process";
  const base = first.replace(/\\/g, "/").split("/").pop() ?? first;
  return base.slice(0, 40) || "process";
}

export function listManagedProcesses(): ManagedProcessView[] {
  return [...registry().values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(toView);
}

export interface StartManagedProcessOptions {
  cwd: string;
  command: string;
  name?: string;
}

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
    status: "running",
    startedAt: Date.now(),
    endedAt: null,
    exitCode: null,
    url: null,
    logs: [],
    child: null,
  };

  const child = spawn(command, {
    cwd: options.cwd,
    shell: true,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
  });
  entry.child = child;

  child.stdout?.on("data", (data: Buffer | string) => {
    pushLog(entry, data.toString());
  });
  child.stderr?.on("data", (data: Buffer | string) => {
    pushLog(entry, data.toString());
  });
  child.on("error", (error) => {
    entry.status = "failed";
    entry.endedAt = Date.now();
    pushLog(entry, `[error] ${error.message}`);
  });
  child.on("exit", (code, signal) => {
    entry.status = entry.status === "failed" ? "failed" : "exited";
    entry.endedAt = Date.now();
    entry.exitCode = code;
    entry.child = null;
    pushLog(entry, `[exit] code=${code ?? "null"} signal=${signal ?? "none"}`);
  });

  registry().set(entry.id, entry);
  return toView(entry);
}

function killTree(entry: ManagedProcessEntry): Promise<void> {
  const child = entry.child;
  if (!child || child.pid === undefined) return Promise.resolve();
  const pid = child.pid;

  return new Promise((resolve) => {
    if (process.platform === "win32") {
      // shell:true on Windows means the direct child is cmd.exe; killing only
      // it leaves the real dev server running, so terminate the tree.
      execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => {
        resolve();
      });
      return;
    }
    try {
      child.kill("SIGTERM");
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
        resolve();
      }, 1500);
    } catch {
      resolve();
    }
  });
}

/** Send one line to the process stdin (REPLs, interactive dev servers). */
export function sendManagedProcessInput(id: string, input: string): boolean {
  const entry = registry().get(id);
  if (!entry || entry.status !== "running" || !entry.child?.stdin?.writable) return false;
  try {
    entry.child.stdin.write(input.endsWith("\n") ? input : input + "\n");
    pushLog(entry, `> ${input}`);
    return true;
  } catch {
    return false;
  }
}

export async function stopManagedProcess(id: string): Promise<boolean> {
  const entry = registry().get(id);
  if (!entry) return false;
  pushLog(entry, "[desktop] stopping…");
  await killTree(entry);
  entry.status = "exited";
  entry.endedAt = entry.endedAt ?? Date.now();
  entry.child = null;
  return true;
}

export async function restartManagedProcess(id: string): Promise<ManagedProcessView | null> {
  const previous = registry().get(id);
  if (!previous) return null;
  await stopManagedProcess(id);
  registry().delete(id);

  const next = startManagedProcess({
    cwd: previous.cwd,
    command: previous.command,
    name: previous.name,
  });
  // Keep history so the panel shows what happened before the restart.
  const entry = registry().get(next.id);
  if (entry) {
    entry.logs = [...previous.logs.slice(-40), "--- restarted ---", ...entry.logs];
  }
  return entry ? toView(entry) : next;
}

export async function removeManagedProcessEntry(id: string): Promise<boolean> {
  const entry = registry().get(id);
  if (!entry) return false;
  if (entry.status === "running") await stopManagedProcess(id);
  return registry().delete(id);
}
