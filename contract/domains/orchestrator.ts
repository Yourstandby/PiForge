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
  /** 是否授予 worker `bash`。默认 false：命令没有路径围栏。 */
  allowBash: boolean;
  /** 该 worker 的分支被合回主干的时刻，未合并为 null。 */
  mergedAt: number | null;
  /** 合并产生的提交（短哈希），未合并为 null。 */
  mergedCommit: string | null;
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
  /** 显式申请 `bash`。默认不给：命令执行没有路径围栏。 */
  allowBash?: boolean;
}
