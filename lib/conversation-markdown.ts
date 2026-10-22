/**
 * Whole-conversation → Markdown, for Ctrl+Shift+C in the chat surface.
 *
 * Runs in the renderer, so it depends only on the normalized message shapes in
 * lib/types.ts (no session files, no node imports). Tool output is clipped so a
 * copy never produces a megabyte-sized clipboard entry.
 */
import type { AgentMessage, ToolResultMessage } from "./types.ts";
import { stripImageDimensionNotes } from "./image-dimension-note.ts";

export interface MarkdownExportOptions {
  /** Characters of tool output kept per result (default 2000). */
  maxToolOutputChars?: number;
  /** Characters of a tool call's JSON input kept (default 500). */
  maxToolInputChars?: number;
}

const DEFAULT_TOOL_OUTPUT_CHARS = 2_000;
const DEFAULT_TOOL_INPUT_CHARS = 500;

function textOf(content: unknown): string {
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

function imageCount(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  return content.filter(
    (block) => Boolean(block) && typeof block === "object" && (block as { type?: unknown }).type === "image",
  ).length;
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…（已截断，原长 ${text.length} 字符）`;
}

function fenced(language: string, body: string): string {
  // Fence with one more backtick than the longest run in the body.
  const longest = Math.max(0, ...Array.from(body.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${body}\n${fence}`;
}

function toolResultBlock(result: ToolResultMessage, options: MarkdownExportOptions): string {
  const limit = options.maxToolOutputChars ?? DEFAULT_TOOL_OUTPUT_CHARS;
  const output = textOf(result.content).trim();
  const images = imageCount(result.content);
  const title = `${result.toolName ?? "tool"} 结果${result.isError ? "（失败）" : ""}`;
  const parts = [`<details><summary>${title}</summary>`, ""];
  if (output) parts.push(fenced("text", clip(output, limit)));
  if (images > 0) parts.push(`_[${images} 张图片附件]_`);
  if (!output && images === 0) parts.push("_（空）_");
  parts.push("", "</details>");
  return parts.join("\n");
}

/** Render the conversation as a copy-pasteable Markdown document. */
export function conversationToMarkdown(
  messages: readonly AgentMessage[],
  options: MarkdownExportOptions = {},
): string {
  const inputLimit = options.maxToolInputChars ?? DEFAULT_TOOL_INPUT_CHARS;
  const blocks: string[] = ["# PiForge 对话导出", ""];

  for (const message of messages) {
    if (message.role === "user") {
      const text = stripImageDimensionNotes(textOf(message.content)).trim();
      const images = imageCount(message.content);
      if (!text && images === 0) continue;
      blocks.push("## 用户", "");
      if (text) blocks.push(text, "");
      if (images > 0) blocks.push(`_[${images} 张图片附件]_`, "");
      continue;
    }

    if (message.role === "assistant") {
      const content = Array.isArray(message.content) ? message.content : [];
      const sections: string[] = [];
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const typed = block as unknown as Record<string, unknown>;
        if (typed.type === "text" && typeof typed.text === "string" && typed.text.trim()) {
          sections.push(typed.text.trim());
        } else if (typed.type === "thinking" && typeof typed.thinking === "string" && typed.thinking.trim()) {
          sections.push(`> 思考：${typed.thinking.trim().replace(/\n/g, "\n> ")}`);
        } else if (typed.type === "toolCall") {
          const name = String(typed.toolName ?? typed.name ?? "tool");
          const input = typed.input ?? typed.arguments ?? {};
          const json = clip(JSON.stringify(input, null, 2) ?? "{}", inputLimit);
          sections.push(`**工具调用** \`${name}\`\n\n${fenced("json", json)}`);
        }
      }
      if (sections.length === 0) continue;
      blocks.push("## 助手", "", sections.join("\n\n"), "");
      continue;
    }

    if (message.role === "toolResult") {
      blocks.push(toolResultBlock(message, options), "");
      continue;
    }

    if (message.role === "custom") {
      const text = textOf(message.content).trim();
      if (!text) continue;
      blocks.push(`### 系统消息 · ${message.customType ?? "custom"}`, "", text, "");
    }
  }

  return blocks.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
