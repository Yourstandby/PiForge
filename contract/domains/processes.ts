/**
 * Managed background processes (`run_bg`, dev servers, watchers).
 *
 * Owned by the Agent Host. Next.js only proxies RPC/SSE.
 *
 * Scope note: this is **lifecycle control, not a security sandbox**. It bounds
 * cleanup of the process trees it starts; it cannot prevent a determined child
 * from escaping (re-parenting, detached daemons, kernel-level tricks). The
 * terminator is an interface so a Job Object / Rust helper can replace the
 * Node implementation later without changing the state machine.
 */

/** Lifecycle status. See `agent-host/process-state.ts` for legal transitions. */
export type ManagedProcessStatus =
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "crashed"
  | "exited";

/** Who asked for this process. Used by cleanup/owner checks. */
export type ManagedProcessOwner = "agent" | "user";

/** How the command string is interpreted (Windows supports PowerShell). */
export type ManagedProcessShell = "cmd" | "powershell";

/** Readiness of a long-running service (dev server, watcher). */
export type ManagedProcessReadiness = "pending" | "ready" | "failed";

/**
 * Why the process is no longer running:
 * - natural: exited on its own (code 0)
 * - crashed: exited on its own with a non-zero code / signal
 * - stopped: the user or the agent asked to stop it (no completion notice)
 * - cleanup-failed: stop was requested but the tree could not be verified gone
 */
export type ManagedProcessExitReason = "natural" | "crashed" | "stopped" | "cleanup-failed";

export interface ManagedProcessEndpoint {
  url: string;
  host: string;
  port: number | null;
}

export interface ManagedProcessCleanup {
  attemptedAt: number;
  ok: boolean;
  /** "taskkill" | "process-group" | "child" — which strategy ran. */
  strategy: string;
  attempts: number;
  forced: boolean;
  error?: string;
}

export interface ManagedProcessView {
  id: string;
  name: string;
  command: string;
  cwd: string;
  shell: ManagedProcessShell;
  owner: ManagedProcessOwner;
  status: ManagedProcessStatus;
  readiness: ManagedProcessReadiness;
  exitReason: ManagedProcessExitReason | null;
  /** Convenience mirror of `readiness === "ready"` (legacy UI). */
  ready: boolean;
  endpoint: ManagedProcessEndpoint | null;
  /** Convenience mirror of `endpoint?.url` (legacy UI). */
  url: string | null;
  pid: number | null;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  /** Incremented by every restart of the same process id. */
  restartCount: number;
  /** Sanitized, line- and byte-bounded log tail. */
  logs: string[];
  /** Total lines ever observed (before truncation), for log cursors. */
  logLineCount: number;
  cleanup: ManagedProcessCleanup | null;
}

/** Internal record persisted for crash recovery (never exposed to the UI). */
export interface ManagedProcessRecord {
  id: string;
  owner: ManagedProcessOwner;
  name: string;
  command: string;
  cwd: string;
  /** Defaults to "cmd" for records written before this field existed. */
  shell?: ManagedProcessShell;
  pid: number | null;
  /** POSIX process group id (= leader pid); null on Windows. */
  pgid: number | null;
  startedAt: number;
  hostInstanceId: string;
}
