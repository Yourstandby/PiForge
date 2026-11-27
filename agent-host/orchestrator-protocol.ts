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
  /**
   * 是否授予 worker `bash`（默认 false）。
   *
   * worktree 只是 cwd 约定，不是内核围栏：给了 bash 就能 `cd ..` 写到主干。
   * 所以命令执行必须由调用方显式申请，而不是默认打开。
   */
  allowBash?: boolean;
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
