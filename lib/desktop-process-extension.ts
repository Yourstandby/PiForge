/**
 * Inline pi extension: `run_bg` managed background processes.
 *
 * The agent can start a dev server / watcher that must outlive a single tool
 * call. Processes are owned by lib/managed-processes.ts and surfaced in the
 * right-panel "进程" tab, where the user can stop or restart them.
 */
import { Type } from "typebox";
import type {
  ExtensionAPI,
  ExtensionFactory,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { startManagedProcess } from "./managed-processes.ts";

export const RUN_BG_TOOL_NAME = "run_bg";

export type DesktopProcessExtensionOptions = {
  /** Session project cwd, resolved at execute time. */
  getCwd: () => string;
};

const RunBgParams = Type.Object({
  command: Type.String({
    description:
      "Shell command to run in the background, e.g. `npm run dev` or `python -m http.server 8000`.",
  }),
  name: Type.Optional(
    Type.String({ description: "Short label shown in the process panel (optional)." }),
  ),
});

function textResult(text: string, details: unknown = {}) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

export function createDesktopProcessFactory(
  options: DesktopProcessExtensionOptions,
): ExtensionFactory {
  const { getCwd } = options;
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: RUN_BG_TOOL_NAME,
      label: "Run Background",
      description:
        "Start a long-running command (dev server, watcher) in the project directory. " +
        "The process keeps running after this tool returns; the user can stop or restart it from the Processes tab.",
      promptSnippet: "Start a background dev server / long-running command",
      parameters: RunBgParams,
      async execute(_toolCallId, params) {
        try {
          const started = startManagedProcess({
            cwd: getCwd(),
            command: params.command,
            name: params.name,
          });
          return textResult(
            [
              `Started background process "${started.name}" (id: ${started.id}).`,
              started.url ? `URL: ${started.url}` : "",
              "It keeps running after this turn. The user can stop/restart it in the Processes tab; do not start the same server twice.",
              "Early output:",
              ...started.logs.slice(-10),
            ]
              .filter(Boolean)
              .join("\n"),
            { processId: started.id, pid: started.pid, url: started.url },
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return textResult(`Failed to start background process: ${message}`, { error: message });
        }
      },
    });
  };
}

export function desktopProcessInlineExtension(
  options: DesktopProcessExtensionOptions,
): InlineExtension {
  return {
    name: "desktop-processes",
    factory: createDesktopProcessFactory(options),
  };
}
