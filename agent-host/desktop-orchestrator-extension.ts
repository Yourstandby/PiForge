/**
 * Inline extension: process-isolated orchestration workers (module 3).
 *
 * The main agent can split a task across independent Git worktrees. Each
 * worker is a separate OS process, so a crash or runaway tool cannot take
 * down the Host or another worker.
 */
import { Type } from "typebox";
import type {
  ExtensionAPI,
  ExtensionFactory,
  InlineExtension,
} from "./sdk-adapter.ts";
import {
  listOrchestratorTasks,
  spawnOrchestratorTask,
  OrchestratorError,
} from "./orchestrator.ts";

export const ORCHESTRATOR_SPAWN_TOOL = "orchestrator_spawn";
export const ORCHESTRATOR_STATUS_TOOL = "orchestrator_status";

const SpawnParams = Type.Object({
  task: Type.String({
    description: "Complete, self-contained task for the worker. Include paths, acceptance criteria, and the required verification.",
  }),
  name: Type.Optional(Type.String({ description: "Short human-readable worker name (e.g. auth-refactor)." })),
  targetCwd: Type.Optional(Type.String({ description: "Optional absolute worktree path. Defaults to a Host-owned scratch worktree." })),
  branchName: Type.Optional(Type.String({ description: "Optional Git branch for the isolated worktree." })),
});

const StatusParams = Type.Object({
  id: Type.Optional(Type.String({ description: "Only return this worker id." })),
});

function summary(task: { name: string; status: string; cwd: string; branchName: string | null; output: string; verified: boolean; filesChanged: string[] }): string {
  return [
    `Worker ${task.name} (${task.status})`,
    `Worktree: ${task.cwd}`,
    task.branchName ? `Branch: ${task.branchName}` : "",
    `Verified: ${task.verified ? "yes" : "no"}`,
    task.filesChanged.length ? `Changed files: ${task.filesChanged.join(", ")}` : "",
    task.output ? `Report:\n${task.output}` : "No report yet.",
  ].filter(Boolean).join("\n");
}

export function createDesktopOrchestratorFactory(): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: ORCHESTRATOR_SPAWN_TOOL,
      label: "Spawn Worktree Worker",
      description:
        "Split one self-contained task into an isolated OS worker process with its own Git worktree. " +
        "Use it for independent, parallel implementation/verification work that can run without the parent context. " +
        "Each worker can edit files and run commands only inside its worktree; its report and changed files return in the status panel.",
      promptSnippet: "Run a task in an isolated worker process and Git worktree",
      promptGuidelines: [
        "Give each worker a standalone brief; it cannot see this conversation.",
        "Use parallel workers only for genuinely independent tasks (different modules or files).",
        "Spawn at most four workers at once and collect their reports before finalizing.",
      ],
      parameters: SpawnParams,
      defaultActive: false,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        try {
          const task = await spawnOrchestratorTask({
            cwd: ctx.cwd,
            task: params.task,
            ...(params.name ? { name: params.name } : {}),
            ...(params.targetCwd ? { targetCwd: params.targetCwd } : {}),
            ...(params.branchName ? { branchName: params.branchName } : {}),
            parentSessionId: ctx.sessionManager.getSessionId(),
          });
          return {
            content: [{ type: "text" as const, text: summary(task) }],
            details: { kind: "orchestrator", ok: true, task },
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [{
              type: "text" as const,
              text: error instanceof OrchestratorError
                ? `Could not spawn worker: ${message}`
                : `Worker failed to start: ${message}`,
            }],
            details: { kind: "orchestrator", ok: false, error: message },
          };
        }
      },
    });

    pi.registerTool({
      name: ORCHESTRATOR_STATUS_TOOL,
      label: "Orchestrator Status",
      description: "List orchestration workers, their worktrees, status, changed files and reports. Use after spawning workers.",
      promptSnippet: "Check worktree worker progress and reports",
      parameters: StatusParams,
      defaultActive: false,
      async execute(_toolCallId, params) {
        const tasks = listOrchestratorTasks().filter((task) => !params.id || task.id === params.id);
        if (tasks.length === 0) {
          return {
            content: [{ type: "text" as const, text: params.id ? `No worker ${params.id}` : "No orchestration workers." }],
            details: { kind: "orchestrator", ok: true, tasks: [] },
          };
        }
        return {
          content: [{ type: "text" as const, text: tasks.map(summary).join("\n\n---\n\n") }],
          details: { kind: "orchestrator", ok: true, tasks },
        };
      },
    });
  };
}

export function desktopOrchestratorInlineExtension(): InlineExtension {
  return {
    name: "desktop-orchestrator",
    factory: createDesktopOrchestratorFactory(),
  };
}
