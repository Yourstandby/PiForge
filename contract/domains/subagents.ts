/**
 * Sub-agents (v0.5.0 stage 7).
 *
 * A sub-agent is a fully isolated AgentSession owned by the Agent Host: its
 * own in-memory SessionManager, its own context, read-only tools, and no access
 * to the parent's JSONL. The parent gets the final answer as a tool result.
 */

export type SubagentStatus = "running" | "completed" | "failed" | "cancelled";

export interface SubagentToolCallView {
  id: string;
  name: string;
  status: "running" | "ok" | "error";
  startedAt: number;
  endedAt: number | null;
  /** Truncated command/path/pattern, used for verification evidence. */
  detail?: string;
}

/** Host-side check of the child's final report for test/build evidence. */
export interface SubagentVerification {
  verified: boolean;
  checkedAt: number;
  /** Human-readable explanation shown in the UI badge tooltip. */
  reason: string;
  /** Bounded excerpts that justified the decision. */
  evidence: string[];
}

export interface SubagentView {
  id: string;
  /** User-facing name chosen by the parent agent. */
  name: string;
  task: string;
  /** Parent agent session that spawned it. */
  parentSessionId: string;
  status: SubagentStatus;
  startedAt: number;
  endedAt: number | null;
  /** Wall-clock elapsed; keeps growing while running. */
  durationMs: number;
  /** Incremental assistant text (tail-capped). */
  output: string;
  toolCalls: SubagentToolCallView[];
  error?: string;
  /** Present after the child finishes; absent while running. */
  verification?: SubagentVerification;
}

/** Lifecycle frames carried on the `subagents` topic (alongside the snapshot). */
export type SubagentLifecycleEvent =
  | { type: "subagent_started"; agent: SubagentView; timestamp: number }
  | {
      type: "subagent_output";
      id: string;
      name: string;
      text: string;
      toolCall?: SubagentToolCallView;
      timestamp: number;
    }
  | { type: "subagent_finished"; agent: SubagentView; timestamp: number };

export interface SubagentSnapshot {
  agents: SubagentView[];
  /** Most recent lifecycle event; absent on the initial snapshot. */
  event?: SubagentLifecycleEvent;
}
