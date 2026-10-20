/**
 * Inline pi extension: `spawn_agent`.
 *
 * Lets the main agent delegate a self-contained research task to an isolated
 * sub-agent. The child has its own context and read-only tools; its final
 * report comes back as this tool's result. Everything runs in the Agent Host.
 */
import { Type } from "typebox";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionFactory,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { SPAWN_AGENT_TOOL_NAME } from "./aux-tool-names.ts";
import { SubagentError, spawnSubagent } from "./subagents.ts";

export { SPAWN_AGENT_TOOL_NAME };

const SpawnAgentParams = Type.Object({
  name: Type.String({
    description: "Short human-readable name for the sub-agent, shown in the Agents panel (e.g. \"auth-reviewer\").",
  }),
  taskPrompt: Type.String({
    description:
      "Complete, self-contained instructions. The sub-agent cannot see the parent conversation, so include paths, goals, and what the final report must contain.",
  }),
});

function summaryOfTask(task: string): string {
  const clean = task.replace(/\s+/g, " ").trim();
  return clean.length > 120 ? `${clean.slice(0, 117)}…` : clean;
}

export function createDesktopSubagentFactory(): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: SPAWN_AGENT_TOOL_NAME,
      label: "Spawn Sub-agent",
      description:
        "Delegate one independent, read-only research task to a sub-agent with its own context. " +
        "The sub-agent can inspect files (read/grep/find/ls) but cannot edit files or run shell commands. " +
        "Its concise report comes back as this tool's result. Spawn several in one turn for independent areas; " +
        "do not use it for work you can finish with one or two tool calls.",
      promptSnippet: "Delegate a read-only research task to an isolated sub-agent",
      promptGuidelines: [
        "Write each taskPrompt as a standalone brief: the sub-agent does not see the main conversation.",
        "Use spawn_agent for parallel, independent investigations; keep the number small (2–4).",
        "After the sub-agents return, synthesise their reports yourself; do not delegate the final answer.",
      ],
      parameters: SpawnAgentParams,
      defaultActive: false,
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const task = params.taskPrompt?.trim() ?? "";
        try {
          const result = await spawnSubagent({
            name: params.name,
            task,
            cwd: ctx.cwd,
            parentSessionId: ctx.sessionManager.getSessionId(),
            ...(ctx.model ? { model: ctx.model as Model<string> } : {}),
            ...(ctx.thinkingLevel ? { thinkingLevel: ctx.thinkingLevel as ThinkingLevel } : {}),
            ...(signal ? { signal } : {}),
          });
          return {
            content: [{ type: "text" as const, text: result.text }],
            details: {
              kind: "subagent",
              ok: result.ok,
              id: result.agent.id,
              name: result.agent.name,
              status: result.agent.status,
              durationMs: result.agent.durationMs,
              task: summaryOfTask(task),
              toolCalls: result.agent.toolCalls.length,
              verified: result.agent.verification?.verified ?? false,
              ...(result.agent.verification?.reason
                ? { verificationReason: result.agent.verification.reason }
                : {}),
              ...(result.error ? { error: result.error } : {}),
            },
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [
              {
                type: "text" as const,
                text: error instanceof SubagentError
                  ? `Could not start a sub-agent: ${message}`
                  : `Sub-agent failed to start: ${message}`,
              },
            ],
            details: {
              kind: "subagent",
              ok: false,
              name: params.name,
              status: "failed",
              task: summaryOfTask(task),
              error: message,
            },
          };
        }
      },
    });
  };
}

export function desktopSubagentInlineExtension(): InlineExtension {
  return {
    name: "desktop-subagents",
    factory: createDesktopSubagentFactory(),
  };
}
