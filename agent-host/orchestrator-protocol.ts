/** JSON-lines protocol between the Host orchestrator and its worker process. */
import type {
  SubagentToolCallView,
  SubagentVerification,
} from "../contract/domains/subagents.ts";

export interface OrchestratorWorkerConfig {
  version: 1;
  taskId: string;
  name: string;
  task: string;
  cwd: string;
  parentSessionId: string;
  parentTaskId: string | null;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
}

export type OrchestratorWorkerMessage =
  | { type: "ready"; pid: number }
  | { type: "progress"; text: string }
  | { type: "tool"; call: SubagentToolCallView }
  | {
      type: "finished";
      ok: boolean;
      output: string;
      toolCalls: SubagentToolCallView[];
      verification: SubagentVerification;
      filesChanged: string[];
      error?: string;
    }
  | { type: "error"; message: string };
