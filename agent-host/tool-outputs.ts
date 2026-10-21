/**
 * Large tool-result persistence (v0.5.0 stage 4).
 *
 * Tool output above a threshold is no longer pushed into the model context in
 * full. The complete text is written under the session's `tool-outputs/`
 * folder and the model receives a head/tail preview plus a `tool_history_get`
 * hint. Everything here runs in the Agent Host.
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, resolve, sep } from "node:path";
import { getAgentDir } from "./sdk-adapter.ts";
import {
  DEFAULT_TOOL_OUTPUT_BUDGET,
  TRUNCATION_HINT,
  countTextLines,
  truncationNotice,
} from "./tool-output-budget.ts";

/**
 * 落盘阈值 = 工具输出预算（100 行 / 8KB）。
 * 超过它就换成「头尾预览 + 指针」，剩下的交给 `tool_history_get` 按页读。
 */
export const TOOL_OUTPUT_MAX_BYTES = DEFAULT_TOOL_OUTPUT_BUDGET.maxBytes;
export const TOOL_OUTPUT_MAX_LINES = DEFAULT_TOOL_OUTPUT_BUDGET.maxLines;
export const PREVIEW_HEAD_LINES = 40;
export const PREVIEW_TAIL_LINES = 40;
export const HISTORY_DEFAULT_LIMIT = 200;
export const HISTORY_MAX_LIMIT = 2_000;

/** Refuse to pull absurdly large files into memory. */
const MAX_FULL_TEXT_BYTES = 32 * 1024 * 1024;
/** A single preview should never be bigger than this, even with long lines. */
const MAX_PREVIEW_BYTES = 16 * 1024;
const PREVIEW_HEAD_CHARS = 8_000;
const PREVIEW_TAIL_CHARS = 6_000;
/** Defensive cap while counting lines for pagination. */
const MAX_SCAN_LINES = 1_000_000;

export const TOOL_HISTORY_TOOL_NAME = "tool_history_get";

/** Details the transcript uses to render "查看完整输出". */
export interface PersistedToolOutput {
  kind: "tool-output";
  toolCallId: string;
  /** Absolute path of the `.log` file. */
  file: string;
  bytes: number;
  lines: number;
  /** Lines shown to the model in the preview. */
  previewLines: number;
  omittedLines: number;
  headLines: number;
  tailLines: number;
}

export interface PreviewResult {
  text: string;
  totalLines: number;
  previewLines: number;
  omittedLines: number;
}

export interface PersistResult {
  marker: PersistedToolOutput;
  previewText: string;
}

export function countLines(text: string): number {
  return countTextLines(text);
}

export function shouldPersistToolOutput(text: string): boolean {
  return Buffer.byteLength(text, "utf8") > TOOL_OUTPUT_MAX_BYTES || countLines(text) > TOOL_OUTPUT_MAX_LINES;
}

/** Tool call ids may contain `/` for nested calls; keep the name filesystem-safe. */
export function sanitizeToolCallId(toolCallId: string): string {
  const safe = toolCallId.trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").slice(0, 120);
  return safe || "tool-call";
}

/** `<sessionDir>/tool-outputs/<sessionId>/<toolCallId>.log` */
export function toolOutputFilePath(sessionDir: string, sessionId: string, toolCallId: string): string {
  return join(sessionDir, "tool-outputs", sanitizeToolCallId(sessionId), `${sanitizeToolCallId(toolCallId)}.log`);
}

/** The hint appended to the preview, as required by the stage-4 spec. */
export function toolHistoryHint(toolCallId: string): string {
  return `【系统提示：输出过大已截断，完整结果已保存。如需查看，请使用 \`${TOOL_HISTORY_TOOL_NAME}\` 工具，传入 toolCallId: ${toolCallId}, offset: 0, limit: ${HISTORY_DEFAULT_LIMIT}】`;
}

/** Head/tail preview with an explicit omission marker and the history hint. */
export function buildToolOutputPreview(fullText: string, toolCallId: string): PreviewResult {
  const lines = fullText.split(/\r?\n/);
  const totalLines = lines.length;
  const hint = toolHistoryHint(toolCallId);

  if (totalLines > PREVIEW_HEAD_LINES + PREVIEW_TAIL_LINES) {
    const head = lines.slice(0, PREVIEW_HEAD_LINES).join("\n");
    const tail = lines.slice(-PREVIEW_TAIL_LINES).join("\n");
    const omittedLines = totalLines - PREVIEW_HEAD_LINES - PREVIEW_TAIL_LINES;
    const text = `${head}\n\n… 【已省略 ${omittedLines} 行】 …\n${truncationNotice(
      totalLines,
      DEFAULT_TOOL_OUTPUT_BUDGET,
    )}\n${TRUNCATION_HINT}\n\n${tail}\n\n${hint}`;
    if (Buffer.byteLength(text, "utf8") > MAX_PREVIEW_BYTES) {
      return charPreview(fullText, totalLines, hint);
    }
    return {
      text,
      totalLines,
      previewLines: PREVIEW_HEAD_LINES + PREVIEW_TAIL_LINES,
      omittedLines,
    };
  }

  // Few (but very long) lines: fall back to a character window.
  return charPreview(fullText, totalLines, hint);
}

function charPreview(fullText: string, totalLines: number, hint: string): PreviewResult {
  if (Buffer.byteLength(fullText, "utf8") <= MAX_PREVIEW_BYTES) {
    return {
      text: `${fullText}\n\n${truncationNotice(totalLines, DEFAULT_TOOL_OUTPUT_BUDGET)}\n${TRUNCATION_HINT}\n\n${hint}`,
      totalLines,
      previewLines: totalLines,
      omittedLines: 0,
    };
  }
  const head = fullText.slice(0, PREVIEW_HEAD_CHARS);
  const tail = fullText.slice(-PREVIEW_TAIL_CHARS);
  const omittedChars = Math.max(0, fullText.length - head.length - tail.length);
  return {
    text: `${head}\n\n… 【已省略 ${omittedChars} 个字符】 …\n${truncationNotice(
      totalLines,
      DEFAULT_TOOL_OUTPUT_BUDGET,
    )}\n${TRUNCATION_HINT}\n\n${tail}\n\n${hint}`,
    totalLines,
    // Long single-line outputs do not map cleanly to line counts.
    previewLines: Math.min(totalLines, PREVIEW_HEAD_LINES + PREVIEW_TAIL_LINES),
    omittedLines: 0,
  };
}

/** Read pi's own bash full-output temp file, when it exists and is readable. */
function readFullOutputFile(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_FULL_TEXT_BYTES) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export interface PersistToolOutputInput {
  sessionDir: string;
  sessionId: string;
  toolCallId: string;
  /** Text the tool returned to the agent (possibly already truncated by pi). */
  text: string;
  /** `details.fullOutputPath` of pi's bash tool, when present. */
  fullOutputPath?: string;
}

/**
 * Decide whether to persist and, if so, write the full text and return the
 * preview that replaces the tool result content.
 */
export function persistToolOutput(input: PersistToolOutputInput): PersistResult | null {
  const fromFile = readFullOutputFile(input.fullOutputPath);
  const fullText = fromFile && fromFile.length > input.text.length ? fromFile : input.text;
  if (!shouldPersistToolOutput(fullText) && !fromFile) return null;

  const preview = buildToolOutputPreview(fullText, input.toolCallId);
  const file = toolOutputFilePath(input.sessionDir, input.sessionId, input.toolCallId);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, fullText, "utf8");
  const bytes = Buffer.byteLength(fullText, "utf8");
  return {
    marker: {
      kind: "tool-output",
      toolCallId: input.toolCallId,
      file,
      bytes,
      lines: preview.totalLines,
      previewLines: preview.previewLines,
      omittedLines: preview.omittedLines,
      headLines: PREVIEW_HEAD_LINES,
      tailLines: PREVIEW_TAIL_LINES,
    },
    previewText: preview.text,
  };
}

/** True only for `.log` files inside `<agent-dir>/sessions/**\/tool-outputs/**`. */
export function isToolOutputPath(file: string): boolean {
  if (typeof file !== "string" || !file.trim()) return false;
  try {
    const resolved = resolve(file);
    const sessionsRoot = resolve(getAgentDir(), "sessions");
    const rootWithSep = sessionsRoot.endsWith(sep) ? sessionsRoot : sessionsRoot + sep;
    if (!resolved.startsWith(rootWithSep)) return false;
    const segments = resolved.slice(rootWithSep.length).split(sep);
    if (!segments.includes("tool-outputs")) return false;
    return resolved.endsWith(".log");
  } catch {
    return false;
  }
}

export interface ToolOutputPage {
  file: string;
  text: string;
  offset: number;
  limit: number;
  totalLines: number;
  hasMore: boolean;
}

/** Read a line window. `offset` is 0-based; `limit` is the number of lines. */
export async function readToolOutputPage(
  file: string,
  offset: number,
  limit: number,
): Promise<ToolOutputPage> {
  if (!existsSync(file)) throw new Error("Tool output file not found");
  const start = Math.max(0, Math.floor(offset));
  const size = Math.min(HISTORY_MAX_LIMIT, Math.max(1, Math.floor(limit)));
  const selected: string[] = [];
  let totalLines = 0;
  let scanned = 0;
  const stream = createReadStream(file, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      if (totalLines >= start && selected.length < size) selected.push(line);
      totalLines += 1;
      scanned += 1;
      if (scanned >= MAX_SCAN_LINES) break;
    }
  } finally {
    reader.close();
    stream.close();
  }
  return {
    file,
    text: selected.join("\n"),
    offset: start,
    limit: size,
    totalLines,
    hasMore: start + selected.length < totalLines,
  };
}
