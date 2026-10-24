/**
 * 消息 content 的纯文本提取。
 *
 * Pi 的消息 content 有两种形态，**必须都处理**：
 * - `string`：`CustomMessage`（扩展 / 宿主用 `sendCustomMessage` 注入的消息）、
 *   部分流式 `message_update` 分片；
 * - `(TextContent | ImageContent | ThinkingContent | ToolCall)[]`：常规 assistant 消息。
 *
 * 只认 `type === "text"` 的 block（thinking / toolCall / image 不参与字数与预览）。
 * 漏掉 string 分支会在 render 期抛 `content.map is not a function`，
 * 直接击穿全局 ErrorBoundary（整屏「出现错误」），因此所有取文本的地方都走这里。
 */

export interface ContentToTextOptions {
  /** 多个 text block 之间的连接符，默认 ""（正文拼接语义）。 */
  separator?: string;
}

export function contentToText(content: unknown, options: ContentToTextOptions = {}): string {
  const { separator = "" } = options;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const typed = block as { type?: string; text?: unknown } | null | undefined;
    if (typed?.type === "text" && typeof typed.text === "string") parts.push(typed.text);
  }
  return parts.join(separator);
}

/** 便捷入口：直接从消息对象取纯文本（消息可能为 null / 半成品流式对象）。 */
export function messageText(
  message: { content?: unknown } | null | undefined,
  options: ContentToTextOptions = {},
): string {
  if (!message) return "";
  return contentToText(message.content, options);
}
