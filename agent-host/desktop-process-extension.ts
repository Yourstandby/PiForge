/**
 * Inline pi extension: managed-process tools.
 *
 *   - `run_bg`       start a long-running managed process (owner = agent)
 *   - `process_read` read logs from an absolute cursor
 *   - `process_wait` wait for readiness or exit with a bounded timeout
 *
 * Deliberately **no** agent-facing stop/restart tools: killing or restarting a
 * process stays a user action in the Processes tab. Processes are owned by the
 * Agent Host (`agent-host/managed-processes.ts`); this is lifecycle control,
 * not a sandbox.
 */
import { Type } from "typebox";
import type {
  ExtensionAPI,
  ExtensionFactory,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";
import type { ManagedProcessView } from "../contract/domains/processes.ts";
import {
  getManagedProcess,
  readManagedProcessLogs,
  startManagedProcess,
  type ManagedProcessLogPage,
} from "./managed-processes.ts";
import {
  PROCESS_READ_TOOL_NAME,
  PROCESS_WAIT_TOOL_NAME,
  RUN_BG_TOOL_NAME,
} from "./process-tool-names.ts";

export { RUN_BG_TOOL_NAME };

export type DesktopProcessExtensionOptions = {
  /** Session project cwd, resolved at execute time. */
  getCwd: () => string;
};

const READ_DEFAULT_LIMIT = 80;
const READ_MAX_LIMIT = 200;
const WAIT_DEFAULT_TIMEOUT_MS = 30_000;
const WAIT_MAX_TIMEOUT_MS = 300_000;
const WAIT_POLL_MS = 250;

const RunBgParams = Type.Object({
  command: Type.String({
    description:
      "Shell command to run in the background, e.g. `npm run dev` or `python -m http.server 8000`.",
  }),
  name: Type.Optional(
    Type.String({ description: "Short label shown in the process panel (optional)." }),
  ),
});

const ProcessReadParams = Type.Object({
  processId: Type.String({
    description: "Managed process id returned by run_bg.",
  }),
  cursor: Type.Optional(
    Type.Number({
      minimum: 0,
      description:
        "Absolute line cursor. Omit on the first read; pass the previous `nextCursor` to fetch only new lines.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: READ_MAX_LIMIT,
      description: `Max lines to return (default ${READ_DEFAULT_LIMIT}, max ${READ_MAX_LIMIT}).`,
    }),
  ),
});

const ProcessWaitParams = Type.Object({
  processId: Type.String({ description: "Managed process id returned by run_bg." }),
  for: Type.Optional(
    Type.Union([Type.Literal("ready"), Type.Literal("exit")], {
      description:
        "ready = wait until the service signals readiness (default); exit = wait until it terminates.",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      minimum: 1_000,
      maximum: WAIT_MAX_TIMEOUT_MS,
      description: `Bounded wait in milliseconds (default ${WAIT_DEFAULT_TIMEOUT_MS}, max ${WAIT_MAX_TIMEOUT_MS}).`,
    }),
  ),
});

function textResult(text: string, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function isTerminal(view: ManagedProcessView): boolean {
  return view.status === "stopped" || view.status === "crashed" || view.status === "exited";
}

function logTail(view: ManagedProcessView, count = 12): string {
  const lines = view.logs.slice(-count);
  return lines.length > 0 ? lines.join("\n") : "(no output yet)";
}

function endpointLine(view: ManagedProcessView): string {
  return view.endpoint ? `URL: ${view.endpoint.url} (port ${view.endpoint.port ?? "?"})` : "";
}

function missingProcess(processId: string) {
  return textResult(
    `No managed process with id "${processId}". It may have been removed; run \`run_bg\` again for a new processId.`,
    { kind: "process", ok: false, processId, error: "process-not-found" },
  );
}

function pageText(view: ManagedProcessView, page: ManagedProcessLogPage): string {
  const startLine = page.totalLines === 0 ? 0 : page.cursor + 1;
  const endLine = page.cursor + page.lines.length;
  return [
    `Process "${view.name}" — status: ${view.status} · readiness: ${view.readiness}`,
    page.totalLines === 0
      ? "The process has not produced any output yet."
      : `Log lines ${startLine}-${endLine} of ${page.totalLines}.`,
    page.nextCursor < page.totalLines
      ? `Next: call ${PROCESS_READ_TOOL_NAME} with processId: ${view.id}, cursor: ${page.nextCursor}.`
      : "End of available log.",
    page.lines.length > 0 ? "---" : "",
    page.lines.join("\n"),
  ]
    .filter((line) => line !== "")
    .join("\n");
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
        "Start a long-running command (dev server, watcher) in the project directory as a managed process. " +
        "It keeps running after this tool returns; the user can stop, force-stop or restart it from the Processes tab. " +
        "Use process_wait to wait for readiness and process_read to inspect logs instead of polling. " +
        "This is lifecycle control, not a sandbox: the host tracks the process tree it started and cleans it up.",
      promptSnippet: "Start a background dev server / long-running command",
      promptGuidelines: [
        "After run_bg, call process_wait with for=ready before opening or fetching the URL.",
        "Use process_read with the returned cursor to inspect logs incrementally; do not re-read from the start.",
      ],
      parameters: RunBgParams,
      async execute(_toolCallId, params) {
        try {
          const started = startManagedProcess({
            cwd: getCwd(),
            command: params.command,
            name: params.name,
            owner: "agent",
          });
          return textResult(
            [
              `Started managed process "${started.name}" (processId: ${started.id}).`,
              `status: ${started.status} · readiness: ${started.readiness}`,
              endpointLine(started),
              "It keeps running after this turn. The user can stop / force-stop / restart it in the Processes tab; do not start the same server twice.",
              `Next: call ${PROCESS_WAIT_TOOL_NAME} with processId: ${started.id} and for: "ready" if you need the service.`,
              "Early output:",
              ...started.logs.slice(-10),
            ]
              .filter(Boolean)
              .join("\n"),
            {
              kind: "process",
              ok: true,
              processId: started.id,
              pid: started.pid,
              owner: started.owner,
              status: started.status,
              readiness: started.readiness,
              endpoint: started.endpoint,
              restartCount: started.restartCount,
              url: started.url,
            },
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return textResult(`Failed to start background process: ${message}`, {
            kind: "process",
            ok: false,
            error: message,
          });
        }
      },
    });

    pi.registerTool({
      name: PROCESS_READ_TOOL_NAME,
      label: "Process Read",
      description:
        "Read a managed process's logs from an absolute cursor. " +
        "Omit cursor for the first read; pass the returned nextCursor to get only new lines. " +
        "Read-only: it cannot stop or restart anything.",
      promptSnippet: "Read managed process logs with a cursor",
      promptGuidelines: [
        "Prefer process_read over re-running commands to inspect a dev server's output.",
        "Keep the cursor between calls so slow-starting services do not re-read old lines.",
      ],
      parameters: ProcessReadParams,
      defaultActive: false,
      async execute(_toolCallId, params) {
        const processId = params.processId?.trim();
        if (!processId) return missingProcess("");
        const view = getManagedProcess(processId);
        if (!view) return missingProcess(processId);
        const rawLimit = params.limit;
        const limit = typeof rawLimit === "number" && Number.isFinite(rawLimit)
          ? Math.max(1, Math.min(READ_MAX_LIMIT, Math.floor(rawLimit)))
          : READ_DEFAULT_LIMIT;
        const rawCursor = params.cursor;
        const page = readManagedProcessLogs(processId, {
          ...(typeof rawCursor === "number" && Number.isFinite(rawCursor)
            ? { cursor: Math.max(0, Math.floor(rawCursor)) }
            : {}),
          limit,
        });
        if (!page) return missingProcess(processId);
        return textResult(pageText(view, page), {
          kind: "process-read",
          ok: true,
          processId,
          cursor: page.cursor,
          nextCursor: page.nextCursor,
          totalLines: page.totalLines,
          status: view.status,
          readiness: view.readiness,
        });
      },
    });

    pi.registerTool({
      name: PROCESS_WAIT_TOOL_NAME,
      label: "Process Wait",
      description:
        "Wait (bounded) until a managed process becomes ready or terminates. " +
        "for=ready (default) resolves on the readiness signal; for=exit resolves when it stops/crashes/exits. " +
        "Read-only: it never stops the process.",
      promptSnippet: "Wait for a managed process to be ready or exit",
      promptGuidelines: [
        "Use process_wait instead of repeated process_read polling while a dev server starts.",
        "If process_wait times out, read the log tail with process_read before deciding to restart anything.",
      ],
      parameters: ProcessWaitParams,
      defaultActive: false,
      async execute(_toolCallId, params, signal) {
        const processId = params.processId?.trim();
        if (!processId) return missingProcess("");
        const initial = getManagedProcess(processId);
        if (!initial) return missingProcess(processId);
        const target = params.for === "exit" ? "exit" : "ready";
        const rawTimeout = params.timeoutMs;
        const timeoutMs = typeof rawTimeout === "number" && Number.isFinite(rawTimeout)
          ? Math.max(1_000, Math.min(WAIT_MAX_TIMEOUT_MS, Math.floor(rawTimeout)))
          : WAIT_DEFAULT_TIMEOUT_MS;
        const deadline = Date.now() + timeoutMs;

        for (;;) {
          const view = getManagedProcess(processId);
          if (!view) return missingProcess(processId);
          if (signal?.aborted) {
            return textResult(`Stopped waiting for "${view.name}" (request aborted).`, {
              kind: "process-wait",
              ok: false,
              processId,
              target,
              aborted: true,
              status: view.status,
              readiness: view.readiness,
            });
          }
          if (target === "ready" && view.readiness === "ready") {
            return textResult(
              [
                `Process "${view.name}" is ready.`,
                `Status: ${view.status} · readiness: ready`,
                endpointLine(view),
                "Recent output:",
                logTail(view),
              ]
                .filter(Boolean)
                .join("\n"),
              {
                kind: "process-wait",
                ok: true,
                processId,
                target,
                timedOut: false,
                status: view.status,
                readiness: view.readiness,
                endpoint: view.endpoint,
                logLineCount: view.logLineCount,
              },
            );
          }
          if (target === "ready" && isTerminal(view)) {
            return textResult(
              [
                `Process "${view.name}" ended before becoming ready.`,
                `Status: ${view.status} · exitReason: ${view.exitReason ?? "unknown"}${view.exitCode !== null ? ` · code ${view.exitCode}` : ""}`,
                "Output:",
                logTail(view),
              ].join("\n"),
              {
                kind: "process-wait",
                ok: false,
                processId,
                target,
                timedOut: false,
                status: view.status,
                readiness: view.readiness,
                exitReason: view.exitReason,
              },
            );
          }
          if (target === "exit" && isTerminal(view)) {
            return textResult(
              [
                `Process "${view.name}" ended.`,
                `Status: ${view.status} · exitReason: ${view.exitReason ?? "unknown"}${view.exitCode !== null ? ` · code ${view.exitCode}` : ""}${view.signal ? ` · signal ${view.signal}` : ""}`,
                "Last output:",
                logTail(view),
              ].join("\n"),
              {
                kind: "process-wait",
                ok: view.exitReason !== "cleanup-failed",
                processId,
                target,
                timedOut: false,
                status: view.status,
                readiness: view.readiness,
                exitReason: view.exitReason,
                exitCode: view.exitCode,
                signal: view.signal,
              },
            );
          }
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            return textResult(
              [
                `Timed out after ${timeoutMs}ms waiting for "${view.name}" to become ${target === "ready" ? "ready" : "terminal"}.`,
                `Current: status ${view.status} · readiness ${view.readiness}`,
                `Use ${PROCESS_READ_TOOL_NAME} with processId: ${view.id}, cursor: ${Math.max(0, view.logLineCount - 40)} to inspect recent output, or wait again with a longer timeout.`,
                "Recent output:",
                logTail(view),
              ].join("\n"),
              {
                kind: "process-wait",
                ok: false,
                processId,
                target,
                timedOut: true,
                status: view.status,
                readiness: view.readiness,
                endpoint: view.endpoint,
                logLineCount: view.logLineCount,
              },
            );
          }
          await sleep(Math.min(WAIT_POLL_MS, remaining));
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
