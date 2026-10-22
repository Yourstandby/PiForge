/**
 * Inline pi extension: Herdr fleet tools.
 *
 * All fleet sessions live in the Agent Host with in-memory SessionManagers;
 * the UI only reads their state. Results carry the sub-agent verification
 * guardrail (verified: false when no test/build evidence exists).
 */
import { Type } from "typebox";
import type { ThinkingLevel } from "./sdk-adapter.ts";
import type { ExtensionAPI, ExtensionFactory, InlineExtension } from "./sdk-adapter.ts";
import type { Model } from "./sdk-adapter.ts";
import {
  getHerdrAgent,
  listHerdrAgents,
  sendHerdrMessage,
  spawnHerdrAgent,
  stopHerdrAgent,
} from "./herdr-manager.ts";

export const HERDR_SPAWN_TOOL_NAME = "herdr_spawn";
export const HERDR_STATUS_TOOL_NAME = "herdr_status";
export const HERDR_MESSAGE_TOOL_NAME = "herdr_message";
export const HERDR_STOP_TOOL_NAME = "herdr_stop";

const TimeoutParam = Type.Optional(
  Type.Number({
    description: "Hard limit for the dispatched task in ms (default 300000 = 5 min). On timeout the fleet agent is killed.",
    minimum: 30_000,
    maximum: 1_800_000,
  }),
);

const SpawnParams = Type.Object({
  name: Type.String({ description: "Fleet agent name shown in the Fleet panel." }),
  taskPrompt: Type.String({
    description: "Standalone first task. The fleet agent keeps context and can receive follow-up messages.",
  }),
  tools: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Extra tools the fleet agent must be able to use (e.g. [\"bash\"]). It already inherits your active tools plus bash/read/write/edit; recursion/UI tools are never granted.",
    }),
  ),
  timeoutMs: TimeoutParam,
});

const StatusParams = Type.Object({
  id: Type.Optional(Type.String({ description: "Fleet agent id; omit to list the whole fleet." })),
});

const MessageParams = Type.Object({
  id: Type.String({ description: "Fleet agent id returned by herdr_spawn." }),
  message: Type.String({ description: "Follow-up instruction for this fleet agent." }),
  timeoutMs: TimeoutParam,
});

function textResult(text: string, details: Record<string, unknown> = {}, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    details,
    ...(isError ? { isError: true } : {}),
  };
}

function verificationLine(verified: boolean, reason: string): string {
  return verified ? `Verification: verified (${reason}).` : `Verification: UNVERIFIED — ${reason}.`;
}

function statusLine(agent: ReturnType<typeof getHerdrAgent>): string {
  if (!agent) return "";
  return [
    `- ${agent.name} (${agent.id}): ${agent.status} / ${agent.activity}`,
    `  turns: ${agent.turns} · duration: ${Math.round(agent.durationMs / 1000)}s · verified: ${agent.verification.verified ? "yes" : "no"}`,
    `  startedAt: ${new Date(agent.startedAt).toISOString()} · finishedAt: ${agent.finishedAt ? new Date(agent.finishedAt).toISOString() : "running"}`,
    agent.error ? `  error: ${agent.error}` : "",
  ].filter(Boolean).join("\n");
}

const StopParams = Type.Object({
  id: Type.Optional(Type.String({ description: "Fleet agent id to stop. Omit with all=true to stop the whole fleet." })),
  all: Type.Optional(Type.Boolean({ description: "Stop every running fleet agent (default false)." })),
});

export function createDesktopHerdrFactory(): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: HERDR_SPAWN_TOOL_NAME,
      label: "Herdr Spawn",
      description:
        "Spawn an isolated fleet agent (in-memory session) that inherits your active tools. " +
        "It exits as soon as its task finishes (no background idling); herdr_status/herdr_message work while it runs. " +
        "Pass timeoutMs when the task can hang — it is killed on timeout. " +
        "Results are checked for test evidence and marked verified:false when none exists.",
      promptSnippet: "Spawn a persistent fleet agent",
      promptGuidelines: [
        "Use herdr_spawn for long-running parallel investigations; use subagents for one-shot tasks.",
        "Poll herdr_status instead of spawning duplicate agents.",
        "Fleet slots are limited (4): a finished or 5-minute-idle agent is released automatically; herdr_stop frees one now.",
      ],
      parameters: SpawnParams,
      defaultActive: false,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        try {
          const agent = spawnHerdrAgent({
            name: params.name,
            ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
            task: params.taskPrompt,
            cwd: ctx.cwd,
            parentSessionId: ctx.sessionManager.getSessionId(),
            ...(params.tools && params.tools.length > 0 ? { tools: [...params.tools] } : {}),
            parentActiveTools: pi.getActiveTools(),
            availableTools: pi.getAllTools().map((tool) => tool.name),
            ...(ctx.model ? { model: ctx.model as Model<string> } : {}),
            ...(ctx.thinkingLevel ? { thinkingLevel: ctx.thinkingLevel as ThinkingLevel } : {}),
          });
          return textResult(
            [
              `Spawned fleet agent "${agent.name}" (id: ${agent.id}).`,
              `status: ${agent.status} · activity: ${agent.activity}`,
              `Use herdr_status with id: ${agent.id} to follow it, or herdr_message to send follow-ups.`,
              verificationLine(agent.verification.verified, agent.verification.reason),
            ].join("\n"),
            { kind: "herdr", id: agent.id, name: agent.name, status: agent.status, verified: agent.verification.verified },
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return textResult(`Could not spawn fleet agent: ${message}`, { kind: "herdr", ok: false, error: message }, true);
        }
      },
    });

    pi.registerTool({
      name: HERDR_STATUS_TOOL_NAME,
      label: "Herdr Status",
      description: "Read the status/output of one fleet agent, or list the whole fleet. Read-only.",
      promptSnippet: "Inspect the Herdr fleet",
      parameters: StatusParams,
      defaultActive: false,
      async execute(_toolCallId, params) {
        if (params.id?.trim()) {
          const agent = getHerdrAgent(params.id.trim());
          if (!agent) return textResult(`No fleet agent with id "${params.id}".`, { kind: "herdr", ok: false }, true);
          return textResult(
            [
              statusLine(agent),
              verificationLine(agent.verification.verified, agent.verification.reason),
              "--- output ---",
              agent.output || "(no output yet)",
            ].join("\n"),
            { kind: "herdr", ok: true, agent },
          );
        }
        const agents = listHerdrAgents();
        return textResult(
          agents.length > 0 ? agents.map(statusLine).join("\n\n") : "The fleet is empty.",
          { kind: "herdr", ok: true, agents },
        );
      },
    });

    pi.registerTool({
      name: HERDR_MESSAGE_TOOL_NAME,
      label: "Herdr Message",
      description: "Send a follow-up message to a running fleet agent and wait for its response (bounded by timeoutMs).",
      promptSnippet: "Message a fleet agent",
      promptGuidelines: ["Keep messages self-contained; the fleet agent keeps its own context."],
      parameters: MessageParams,
      defaultActive: false,
      async execute(_toolCallId, params) {
        try {
          const result = await sendHerdrMessage(params.id, params.message, params.timeoutMs);
          return textResult(
            [
              `Fleet agent "${result.agent.name}" replied (${result.agent.status} / ${result.agent.activity}).`,
              verificationLine(result.agent.verification.verified, result.agent.verification.reason),
              "--- reply ---",
              result.text,
            ].join("\n"),
            {
              kind: "herdr",
              ok: result.ok,
              id: result.agent.id,
              status: result.agent.status,
              verified: result.agent.verification.verified,
              finishedAt: result.agent.finishedAt,
              ...(result.error ? { error: result.error } : {}),
            },
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return textResult(`Herdr message failed: ${message}`, { kind: "herdr", ok: false, error: message }, true);
        }
      },
    });
    pi.registerTool({
      name: HERDR_STOP_TOOL_NAME,
      label: "Herdr Stop",
      description: "Stop (sleep) a fleet agent or the whole fleet. Frees a fleet slot; the config can be woken again.",
      promptSnippet: "Stop a fleet agent",
      promptGuidelines: ["Use it when a worker is done or idle: fleet slots are limited."],
      parameters: StopParams,
      defaultActive: false,
      async execute(_toolCallId, params) {
        try {
          if (params.all === true) {
            const victims = listHerdrAgents().filter(
              (agent) => agent.status !== "exited" && agent.status !== "stopped" && agent.status !== "crashed",
            );
            for (const agent of victims) await stopHerdrAgent(agent.id, "主 Agent 收编：整队停止");
            return textResult(`Stopped ${victims.length} fleet agent(s).`, {
              kind: "herdr",
              ok: true,
              stopped: victims.map((agent) => agent.id),
            });
          }
          const id = params.id?.trim();
          if (!id) return textResult("Provide an agent id, or all=true.", { kind: "herdr", ok: false }, true);
          const stopped = await stopHerdrAgent(id, "主 Agent 收编：手动停止");
          return stopped
            ? textResult(`Fleet agent "${id}" stopped.`, { kind: "herdr", ok: true, id })
            : textResult(`No running fleet agent with id "${id}".`, { kind: "herdr", ok: false, id }, true);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return textResult(`Herdr stop failed: ${message}`, { kind: "herdr", ok: false, error: message }, true);
        }
      },
    });
  };
}

export function desktopHerdrInlineExtension(): InlineExtension {
  return { name: "desktop-herdr", factory: createDesktopHerdrFactory() };
}
