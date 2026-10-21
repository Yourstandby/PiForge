/**
 * Standalone orchestrator worker (v0.7.0 module 3).
 *
 * This file is launched as a separate OS process by orchestrator.ts. It owns
 * one AgentSession inside its assigned Git worktree and reports JSON lines on
 * stdout; it never receives the Host launch token or the Host's IPC objects.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { ThinkingLevel } from "./sdk-adapter.ts";
import {
  DefaultResourceLoader,
  SessionManager,
  createHostAgentSession,
  getAgentDir,
} from "./sdk-adapter.ts";
import type { SubagentToolCallView } from "../contract/domains/subagents.ts";
import { getSharedAuxRuntime } from "./aux-models.ts";
import type {
  OrchestratorWorkerConfig,
  OrchestratorWorkerMessage,
} from "./orchestrator-protocol.ts";
import { checkSubagentVerification } from "./subagent-verification.ts";

const WORKER_TOOLS = ["read", "write", "edit", "grep", "find", "ls", "bash"];

function emit(message: OrchestratorWorkerMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } =>
      Boolean(block) && typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

function changedFiles(cwd: string): string[] {
  try {
    const output = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000,
    });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 200);
  } catch {
    return [];
  }
}

function workerPrompt(config: OrchestratorWorkerConfig): string {
  return [
    "You are an isolated PiForge orchestration worker running in your own Git worktree.",
    `Task: ${config.task}`,
    `Worktree: ${config.cwd}`,
    "Work only inside this worktree. Do not touch sibling worktrees or the parent repository.",
    "You may edit files and run commands in this worktree. Verify your changes with tests or a build when possible.",
    "Finish with a concise report: what changed, files/paths, commands run, verification evidence, and any remaining risk.",
  ].join("\n");
}

async function main(): Promise<void> {
  const configPath = process.env.PIFORGE_ORCHESTRATOR_CONFIG_PATH;
  if (!configPath) throw new Error("PIFORGE_ORCHESTRATOR_CONFIG_PATH is required");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as OrchestratorWorkerConfig;
  if (config.version !== 1) throw new Error("unsupported orchestrator worker config version");

  const agentDir = getAgentDir();
  const toolCalls: SubagentToolCallView[] = [];
  let output = "";

  const resourceLoader = new DefaultResourceLoader({
    cwd: config.cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();

  const runtime = await getSharedAuxRuntime();
  const model = config.provider && config.modelId
    ? runtime.getModel(config.provider, config.modelId)
    : undefined;
  const { session } = await createHostAgentSession({
    cwd: config.cwd,
    agentDir,
    sessionManager: SessionManager.create(config.cwd, undefined),
    resourceLoader,
    modelRuntime: runtime,
    tools: WORKER_TOOLS,
    ...(model ? { model } : {}),
    ...(config.thinkingLevel ? { thinkingLevel: config.thinkingLevel as ThinkingLevel } : {}),
  });

  session.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "assistant") {
      const text = textOfContent(event.message.content).trim();
      if (text) {
        output = text;
        emit({ type: "progress", text });
      }
      return;
    }
    if (event.type === "tool_execution_start") {
      const args = (event.args ?? {}) as Record<string, unknown>;
      const raw = args.path ?? args.pattern ?? args.query ?? args.command;
      const call: SubagentToolCallView = {
        id: event.toolCallId,
        name: event.toolName,
        status: "running",
        startedAt: Date.now(),
        endedAt: null,
        ...(typeof raw === "string" ? { detail: raw.slice(0, 500) } : {}),
      };
      toolCalls.push(call);
      emit({ type: "tool", call: { ...call } });
      return;
    }
    if (event.type === "tool_execution_end") {
      const call = toolCalls.find((item) => item.id === event.toolCallId);
      if (call) {
        call.status = event.isError ? "error" : "ok";
        call.endedAt = Date.now();
        emit({ type: "tool", call: { ...call } });
      }
    }
  });

  emit({ type: "ready", pid: process.pid });

  try {
    await session.prompt(workerPrompt(config));
    const verification = checkSubagentVerification({ output, toolCalls });
    emit({
      type: "finished",
      ok: true,
      output,
      toolCalls,
      verification,
      filesChanged: changedFiles(config.cwd),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit({
      type: "finished",
      ok: false,
      output,
      toolCalls,
      verification: checkSubagentVerification({ output, toolCalls }),
      filesChanged: changedFiles(config.cwd),
      error: message,
    });
  } finally {
    try {
      session.dispose();
    } catch {
      // best effort
    }
  }
}

if (process.env.PIFORGE_ORCHESTRATOR_CONFIG_PATH) {
  // Keep agent libraries from corrupting the JSON-lines stdout channel.
  console.log = (...args: unknown[]) => console.error(...args);
  console.info = (...args: unknown[]) => console.error(...args);
  void main().then(
    () => process.exit(0),
    (error: unknown) => {
      emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
      process.exit(1);
    },
  );
}
