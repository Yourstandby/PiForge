/** Agent fleet ("Herdr") records. All execution stays inside the Agent Host. */
import type { ManagedProcessStatus } from "./processes.ts";
import type { SubagentToolCallView, SubagentVerification } from "./subagents.ts";

export type HerdrActivity = "working" | "idle";

export interface HerdrAgentView {
  id: string;
  name: string;
  task: string;
  parentSessionId: string;
  /** Reuses the managed-process lifecycle enum; terminal states never resume. */
  status: ManagedProcessStatus;
  activity: HerdrActivity;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  turns: number;
  output: string;
  toolCalls: SubagentToolCallView[];
  verification: SubagentVerification;
  error?: string;
}
