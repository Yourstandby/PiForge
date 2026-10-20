/**
 * Inline pi extension: mirror shell tool runs into the right-panel Terminal.
 *
 * The shell-output ring buffer now lives in the Agent Host; this extension
 * forwards `bash` / `powershell` tool events over RPC so the UI keeps working
 * unchanged. Fire-and-forget writes preserve their ordering because they share
 * one ordered pipe connection.
 */
import type {
  ExtensionAPI,
  ExtensionFactory,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";
import type { AgentHostClient } from "../contract/client.ts";
import type { Params } from "../contract/methods.ts";
import type { TerminalBlockStatus } from "../contract/domains/terminal.ts";
import { getAgentHostClient } from "./agent-host-client.ts";

const SHELL_TOOL_NAMES: readonly string[] = ["bash", "powershell"];

export type DesktopTerminalExtensionOptions = {
  /** Session project cwd, resolved at execute time. */
  getCwd: () => string;
  /** Test/alternate transport hook; defaults to the shared host client. */
  client?: Pick<AgentHostClient, "call">;
};

function commandOf(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const command = (input as { command?: unknown }).command;
  return typeof command === "string" ? command.trim() : "";
}

function textOf(content: unknown): string {
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

/**
 * Mirroring is best-effort: a host hiccup must never fail the agent's shell
 * call, so every RPC is detached and errors are logged only once per call.
 */
function mirror<M extends "terminal.shellStart" | "terminal.shellUpdate" | "terminal.shellFinish">(
  client: Pick<AgentHostClient, "call">,
  method: M,
  params: Params<M>,
): void {
  void client.call(method, params).catch((error: unknown) => {
    console.error(`terminal mirror ${method} failed:`, error);
  });
}

export function createDesktopTerminalFactory(
  options: DesktopTerminalExtensionOptions,
): ExtensionFactory {
  const { getCwd } = options;
  const client = options.client ?? getAgentHostClient();
  return (pi: ExtensionAPI) => {
    pi.on("tool_call", (event) => {
      if (!SHELL_TOOL_NAMES.includes(event.toolName)) return;
      const command = commandOf(event.input);
      if (!command) return;
      mirror(client, "terminal.shellStart", {
        id: event.toolCallId,
        command,
        cwd: getCwd(),
      });
    });

    pi.on("tool_execution_update", (event) => {
      if (!SHELL_TOOL_NAMES.includes(event.toolName)) return;
      // pi sends the accumulated snapshot of the running command's output.
      const text = textOf((event.partialResult as { content?: unknown } | undefined)?.content);
      if (text) {
        mirror(client, "terminal.shellUpdate", { id: event.toolCallId, text });
      }
    });

    pi.on("tool_result", (event) => {
      if (!SHELL_TOOL_NAMES.includes(event.toolName)) return;
      const status: TerminalBlockStatus = event.isError ? "error" : "ok";
      mirror(client, "terminal.shellFinish", {
        id: event.toolCallId,
        text: textOf(event.content),
        status,
      });
    });
  };
}

export function desktopTerminalInlineExtension(
  options: DesktopTerminalExtensionOptions,
): InlineExtension {
  return {
    name: "desktop-terminal",
    factory: createDesktopTerminalFactory(options),
  };
}
