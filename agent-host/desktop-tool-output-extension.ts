/**
 * Inline pi extension: persist oversized tool results + `tool_history_get`.
 *
 * The `tool_result` hook replaces a large result with a head/tail preview and
 * a pointer to the full `.log` file. The agent can page through that file with
 * `tool_history_get`, even after context compaction.
 */
import { existsSync } from "node:fs";
import { Type } from "typebox";
import type {
  ExtensionAPI,
  ExtensionFactory,
  InlineExtension,
} from "./sdk-adapter.ts";
import {
  HISTORY_DEFAULT_LIMIT,
  HISTORY_MAX_LIMIT,
  TOOL_HISTORY_TOOL_NAME,
  persistToolOutput,
  readToolOutputPage,
  toolOutputFilePath,
} from "./tool-outputs.ts";
import {
  TRUNCATION_HINT,
  toolOutputBudget,
  truncateToolOutput,
} from "./tool-output-budget.ts";

/**
 * 已在工具内部自带界限 / 可从磁盘回读的工具（`write`/`edit` 只回一行确认）。
 * `read` 不再豁免：它是最多行的输出源，走文件内容预算（头 300 行 + offset 续读）。
 */
const EXEMPT_TOOLS = new Set<string>(["write", "edit", TOOL_HISTORY_TOOL_NAME]);

const READ_TOOL_NAME = "read";
/** read 被截断时额外给一句针对性引导（offset 是它自己的分页参数）。 */
const READ_CONTINUE_HINT =
  "也可以用 read 的 offset/limit 从上次中断处继续（例：offset=301, limit=300）。";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } =>
      isRecord(block) && block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

/** pi's bash tool saves the untruncated output here. */
function fullOutputPathOf(details: unknown): string | undefined {
  if (!isRecord(details)) return undefined;
  return typeof details.fullOutputPath === "string" ? details.fullOutputPath : undefined;
}

const HistoryParams = Type.Object({
  toolCallId: Type.String({
    description: "Tool call id shown in the truncation hint (for example the id of a previous bash call).",
  }),
  offset: Type.Optional(
    Type.Number({ minimum: 0, description: "0-based start line (default 0)." }),
  ),
  limit: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: HISTORY_MAX_LIMIT,
      description: `Number of lines to return (default ${HISTORY_DEFAULT_LIMIT}, max ${HISTORY_MAX_LIMIT}).`,
    }),
  ),
});

function failure(text: string, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text }],
    details: { kind: "tool-history", ok: false, ...details },
  };
}

export function createDesktopToolOutputFactory(): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.on("tool_result", (event, ctx) => {
      if (EXEMPT_TOOLS.has(event.toolName)) return;
      const text = textOf(event.content);
      const fullOutputPath = fullOutputPathOf(event.details);
      if (!text && !fullOutputPath) return;

      /** 文件内容型（read）：只裁不落盘 —— 源文件本来就在磁盘上，用 offset 续读。 */
      if (event.toolName === READ_TOOL_NAME) {
        // 预算走 toolOutputBudget()：开关关闭时返回的就是 READ_TOOL_OUTPUT_BUDGET 本身。
        const truncation = truncateToolOutput(text, toolOutputBudget(event.toolName));
        if (!truncation.truncated) return;
        const nonText = event.content.filter((block) => block.type !== "text");
        const baseDetails = isRecord(event.details) ? event.details : {};
        return {
          content: [
            {
              type: "text" as const,
              text: `${truncation.text}\n${TRUNCATION_HINT}\n${READ_CONTINUE_HINT}`,
            },
            ...nonText,
          ],
          details: {
            ...baseDetails,
            toolOutputTruncation: {
              kind: "read-truncated",
              totalLines: truncation.totalLines,
              keptLines: truncation.keptLines,
              truncatedBy: truncation.truncatedBy,
            },
          },
        };
      }

      let sessionDir: string;
      let sessionId: string;
      try {
        sessionDir = ctx.sessionManager.getSessionDir();
        sessionId = ctx.sessionManager.getSessionId();
      } catch {
        return;
      }
      if (!sessionDir || !sessionId) return;

      const persisted = persistToolOutput({
        sessionDir,
        sessionId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        text,
        ...(fullOutputPath ? { fullOutputPath } : {}),
      });
      if (!persisted) return;

      const nonText = event.content.filter((block) => block.type !== "text");
      const baseDetails = isRecord(event.details) ? event.details : {};
      return {
        // Replace only the text: images and other blocks stay intact.
        content: [{ type: "text" as const, text: persisted.previewText }, ...nonText],
        details: { ...baseDetails, toolOutput: persisted.marker },
        // Codemode scripts get the machine-readable copy; the model context
        // keeps only the preview.
        ...(event.structuredContent !== undefined
          ? { structuredContent: event.structuredContent }
          : {}),
      };
    });

    pi.registerTool({
      name: TOOL_HISTORY_TOOL_NAME,
      label: "Tool History",
      description:
        "Read the full output of a previous tool call that was too large for the context. " +
        "Use the toolCallId from the truncation hint and page with offset/limit.",
      promptSnippet: "Read a persisted oversized tool output",
      promptGuidelines: [
        "When a tool result says the output was truncated, call tool_history_get with that toolCallId instead of re-running the command.",
        `Page through large outputs with offset/limit; the default page is ${HISTORY_DEFAULT_LIMIT} lines and the maximum is ${HISTORY_MAX_LIMIT}.`,
      ],
      parameters: HistoryParams,
      defaultActive: false,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const requestedId = params.toolCallId?.trim();
        if (!requestedId) return failure("toolCallId is required.");
        let sessionDir: string;
        let sessionId: string;
        try {
          sessionDir = ctx.sessionManager.getSessionDir();
          sessionId = ctx.sessionManager.getSessionId();
        } catch {
          return failure("No active session: tool output history is unavailable.");
        }
        const file = toolOutputFilePath(sessionDir, sessionId, requestedId);
        if (!existsSync(file)) {
          return failure(
            `No persisted output for toolCallId "${requestedId}" in this session. It may be under the size limit, from another session, or already cleaned up.`,
            { toolCallId: requestedId, file },
          );
        }
        const rawOffset = params.offset;
        const rawLimit = params.limit;
        const offset = typeof rawOffset === "number" && Number.isFinite(rawOffset)
          ? Math.max(0, Math.floor(rawOffset))
          : 0;
        const limit = typeof rawLimit === "number" && Number.isFinite(rawLimit)
          ? Math.max(1, Math.min(HISTORY_MAX_LIMIT, Math.floor(rawLimit)))
          : HISTORY_DEFAULT_LIMIT;
        try {
          const page = await readToolOutputPage(file, offset, limit);
          const startLine = page.totalLines === 0 ? 0 : page.offset + 1;
          const endLine = page.offset + (page.text ? page.text.split("\n").length : 0);
          const header = [
            `Tool output for ${requestedId} — lines ${startLine}-${endLine} of ${page.totalLines}${page.hasMore ? " (more available)" : ""}.`,
            page.hasMore
              ? `Next page: offset ${page.offset + limit}, limit ${limit}.`
              : "End of output.",
            "",
          ].join("\n");
          return {
            content: [{ type: "text" as const, text: `${header}${page.text || "(empty)"}` }],
            details: {
              kind: "tool-history",
              ok: true,
              toolCallId: requestedId,
              file,
              offset: page.offset,
              limit: page.limit,
              totalLines: page.totalLines,
              hasMore: page.hasMore,
            },
          };
        } catch (error) {
          return failure(
            `Could not read the persisted output: ${error instanceof Error ? error.message : String(error)}`,
            { toolCallId: requestedId, file },
          );
        }
      },
    });
  };
}

export function desktopToolOutputInlineExtension(): InlineExtension {
  return {
    name: "desktop-tool-outputs",
    factory: createDesktopToolOutputFactory(),
  };
}
