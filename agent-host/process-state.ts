/**
 * Managed-process state machine.
 *
 * Kept pure so the legal transitions can be unit-tested and documented.
 *
 *   starting ──► running ──► stopping ──► stopped
 *      │           │            │
 *      │           ├──► exited  └──► crashed (cleanup failed / killed abnormally)
 *      └──► crashed / exited / stopped
 *
 * Terminal states (stopped/crashed/exited) never transition on their own.
 * `restart()` is the only edge back to `starting`, and it is modeled
 * separately so an accidental `transition("stopped", "running")` still fails.
 */
import type {
  ManagedProcessExitReason,
  ManagedProcessStatus,
} from "../contract/domains/processes.ts";

export const PROCESS_TRANSITIONS: Readonly<
  Record<ManagedProcessStatus, readonly ManagedProcessStatus[]>
> = {
  starting: ["running", "stopping", "stopped", "crashed", "exited"],
  running: ["stopping", "exited", "crashed"],
  stopping: ["stopped", "crashed"],
  stopped: [],
  crashed: [],
  exited: [],
};

/** Statuses a `restart()` may start from (terminal only). */
export const PROCESS_RESTARTABLE: readonly ManagedProcessStatus[] = [
  "stopped",
  "crashed",
  "exited",
];

export class ProcessStateError extends Error {
  readonly from: ManagedProcessStatus;
  readonly to: ManagedProcessStatus;

  constructor(from: ManagedProcessStatus, to: ManagedProcessStatus) {
    super(`Illegal managed-process transition: ${from} → ${to}`);
    this.name = "ProcessStateError";
    this.from = from;
    this.to = to;
  }
}

export function isTerminalStatus(status: ManagedProcessStatus): boolean {
  return PROCESS_TRANSITIONS[status].length === 0;
}

export function canTransition(
  from: ManagedProcessStatus,
  to: ManagedProcessStatus,
): boolean {
  return PROCESS_TRANSITIONS[from].includes(to);
}

/** Throws on an illegal edge so a bug can never silently corrupt the view. */
export function assertTransition(
  from: ManagedProcessStatus,
  to: ManagedProcessStatus,
): void {
  if (!canTransition(from, to)) throw new ProcessStateError(from, to);
}

export function canRestart(status: ManagedProcessStatus): boolean {
  return PROCESS_RESTARTABLE.includes(status);
}

/**
 * Status + reason from a natural `exit` event.
 *
 * A stop request wins over the exit code: termination signals are expected and
 * must not be reported as a crash, and stopped processes must not fire
 * completion notifications.
 */
export function statusAfterExit(
  current: ManagedProcessStatus,
  code: number | null,
  signal: string | null,
): { status: ManagedProcessStatus; exitReason: ManagedProcessExitReason } {
  if (current === "stopping") {
    return { status: "stopped", exitReason: "stopped" };
  }
  if (signal === null && code === 0) {
    return { status: "exited", exitReason: "natural" };
  }
  return { status: "crashed", exitReason: "crashed" };
}
