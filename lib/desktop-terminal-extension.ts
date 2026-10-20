/**
 * Inline pi extension: mirror shell tool runs into the right-panel Terminal.
 *
 * `run_bg` output already streams through the managed-process registry; this
 * covers the ordinary `bash` / `powershell` tool calls, which would otherwise
 * only exist inside the transcript. Output is stored verbatim (ANSI intact) in
 * lib/terminal-log.ts and rendered by components/TerminalPanel.tsx.
 */
import type {
  ExtensionAPI,
  ExtensionFactory,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { finishShellBlock, setShellOutput, startShellBlock } from "./terminal-log.ts";

const SHELL_TOOL_NAMES: readonly string[] = ["bash", "powershell"];

export type DesktopTerminalExtensionOptions = {
  /** Session project cwd, resolved at execute time. */
  getCwd: () => string;
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

export function createDesktopTerminalFactory(
  options: DesktopTerminalExtensionOptions,
): ExtensionFactory {
  const { getCwd } = options;
  return (pi: ExtensionAPI) => {
    pi.on("tool_call", (event) => {
      if (!SHELL_TOOL_NAMES.includes(event.toolName)) return;
      const command = commandOf(event.input);
      if (!command) return;
      startShellBlock({ id: event.toolCallId, command, cwd: getCwd() });
    });

    pi.on("tool_execution_update", (event) => {
      if (!SHELL_TOOL_NAMES.includes(event.toolName)) return;
      // pi sends the accumulated snapshot of the running command's output.
      const text = textOf((event.partialResult as { content?: unknown } | undefined)?.content);
      if (text) setShellOutput(event.toolCallId, text);
    });

    pi.on("tool_result", (event) => {
      if (!SHELL_TOOL_NAMES.includes(event.toolName)) return;
      finishShellBlock({
        id: event.toolCallId,
        text: textOf(event.content),
        status: event.isError ? "error" : "ok",
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
