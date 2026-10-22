/** Agent fleet ("Herdr") records. All execution stays inside the Agent Host. */
import type { ManagedProcessStatus } from "./processes.ts";
import type { SubagentToolCallView, SubagentVerification } from "./subagents.ts";

export type HerdrActivity = "working" | "idle";

export interface HerdrAgentView {
  id: string;
  name: string;
  task: string;
  parentSessionId: string;
  /** Working directory of the parent session (project attribution in the rail). */
  cwd?: string;
  /** Reuses the managed-process lifecycle enum; terminal states never resume. */
  status: ManagedProcessStatus;
  activity: HerdrActivity;
  startedAt: number;
  /** 最近一次「开始/结束一轮」的时间戳：空闲托管按它判超时。 */
  lastActivityAt: number;
  endedAt: number | null;
  durationMs: number;
  /** Convenience alias of endedAt; null while the agent is still alive. */
  finishedAt: number | null;
  /** Aggregate of verification.verified for quick fleet display. */
  verified: boolean;
  turns: number;
  output: string;
  toolCalls: SubagentToolCallView[];
  verification: SubagentVerification;
  error?: string;
}
