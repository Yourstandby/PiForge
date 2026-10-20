/**
 * Method map for the Agent Host contract.
 *
 * Naming: `<domain>.<verb>`, lower-case, dot separated. Parameters and
 * results are always objects so additive fields stay backwards compatible.
 */
import type { ManagedProcessView } from "./domains/processes.ts";
import type { TerminalBlock, TerminalBlockStatus } from "./domains/terminal.ts";
import type { GlobalTopic } from "./events.ts";

export interface HostHealth {
  ok: boolean;
  pid: number;
  uptimeMs: number;
  protocolVersion: number;
  /** Connections accepted since host start. */
  connections: number;
  /** Connections that completed the handshake. */
  handshaked: number;
  /** Requests handled since host start. */
  requests: number;
  /** Managed background processes currently tracked (running or exited). */
  processes: number;
  /** Live agent sessions (0 until the Pi SDK moves into the host). */
  sessions: number;
}

export interface AgentHostMethods {
  "host.health": {
    params: Record<string, never>;
    result: HostHealth;
  };
  "host.shutdown": {
    params: { drainMs?: number };
    result: { closedSessions: number; stoppedProcesses: number };
  };
  "host.subscribe": {
    params: { topics: GlobalTopic[] };
    result: { subscriptionId: string };
  };
  "host.unsubscribe": {
    params: { subscriptionId: string };
    result: { ok: true };
  };

  // ---- managed background processes ----
  "processes.list": {
    params: Record<string, never>;
    result: { processes: ManagedProcessView[] };
  };
  "processes.start": {
    params: { cwd: string; command: string; name?: string };
    result: { process: ManagedProcessView };
  };
  "processes.stop": {
    params: { id: string };
    result: { ok: boolean };
  };
  "processes.restart": {
    params: { id: string };
    result: { process: ManagedProcessView | null };
  };
  "processes.remove": {
    params: { id: string };
    result: { ok: boolean };
  };
  "processes.stdin": {
    params: { id: string; input: string };
    result: { ok: boolean };
  };

  // ---- shell-output terminal log ----
  "terminal.list": {
    params: Record<string, never>;
    result: { blocks: TerminalBlock[] };
  };
  "terminal.clear": {
    params: Record<string, never>;
    result: { ok: true };
  };
  "terminal.shellStart": {
    params: { id: string; command: string; cwd?: string | null };
    result: { ok: true };
  };
  "terminal.shellUpdate": {
    params: { id: string; text: string };
    result: { ok: true };
  };
  "terminal.shellFinish": {
    params: { id: string; text?: string; status?: TerminalBlockStatus };
    result: { ok: boolean };
  };
}

export type MethodName = keyof AgentHostMethods;
export type Params<M extends MethodName> = AgentHostMethods[M]["params"];
export type Result<M extends MethodName> = AgentHostMethods[M]["result"];

/**
 * Guard used by the host to reject unknown methods before dispatch. Keep it
 * in sync with the implementations in `agent-host/`.
 */
export const IMPLEMENTED_HOST_METHODS = [
  "host.health",
  "host.shutdown",
  "host.subscribe",
  "host.unsubscribe",
  "processes.list",
  "processes.start",
  "processes.stop",
  "processes.restart",
  "processes.remove",
  "processes.stdin",
  "terminal.list",
  "terminal.clear",
  "terminal.shellStart",
  "terminal.shellUpdate",
  "terminal.shellFinish",
] as const satisfies readonly MethodName[];
