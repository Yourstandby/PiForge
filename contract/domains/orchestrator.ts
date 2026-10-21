/** Process-isolated orchestration workers (v0.7.0 module 3). */
import type { ManagedProcessStatus } from "./processes.ts";
import type { SubagentToolCallView, SubagentVerification } from "./subagents.ts";

export type OrchestratorActivity = "working" | "idle";

export interface OrchestratorTaskView {
  id: string;
  name: string;
  task: string;
  /** Main session that requested this worker, or a parent worker task id. */
  parentSessionId: string;
  parentTaskId: string | null;
  status: ManagedProcessStatus;
  activity: OrchestratorActivity;
  /** Independent Git worktree assigned to this worker. */
  cwd: string;
  branchName: string | null;
  repoRoot: string | null;
  workerPid: number | null;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number;
  verified: boolean;
  output: string;
  toolCalls: SubagentToolCallView[];
  filesChanged: string[];
  verification: SubagentVerification;
  error?: string;
}

export interface OrchestratorSpawnInput {
  cwd: string;
  task: string;
  name?: string;
  parentSessionId: string;
  parentTaskId?: string | null;
  targetCwd?: string;
  branchName?: string;
}
