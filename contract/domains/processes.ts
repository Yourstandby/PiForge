/**
 * Managed background processes (`run_bg`, dev servers, watchers).
 *
 * Owned by the Agent Host. The UI receives these views through
 * `processes.changed` events and renders them unchanged.
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
