import type { AgentMessage, UserMessage } from "../../lib/types.ts";
import { normalizeUserTextForMatch } from "../../lib/image-dimension-note.ts";

export function reconcilePendingUserMessage(
  messages: AgentMessage[],
  canonical: UserMessage,
  clientMessageId: string
): { reconciled: boolean; messages: AgentMessage[] } {
  const index = messages.findIndex(
    (message) => message.role === "user" && message.clientMessageId === clientMessageId
  );
  if (index === -1) return { reconciled: false, messages };

  const pending = messages[index] as UserMessage;
  const reconciled = [...messages];
  reconciled[index] = { ...canonical, timestamp: pending.timestamp };
  return { reconciled: true, messages: reconciled };
}

export function reconcileOrAppendPendingUserMessage(
  messages: AgentMessage[],
  canonical: UserMessage,
  clientMessageId: string
): AgentMessage[] {
  const reconciliation = reconcilePendingUserMessage(messages, canonical, clientMessageId);
  if (reconciliation.reconciled) return reconciliation.messages;

  // 兜底去重：id 对不上（例如带图消息的文本被 pi 追加了坐标说明）时，
  // 找到内容相同的乐观气泡就地替换，绝不再追加一条，避免重复显示。
  const canonicalText = userTextOf(canonical);
  const duplicateIndex = messages.findIndex((message, index) => {
    if (message.role !== "user") return false;
    if (index !== messages.length - 1) return false;
    return normalizeUserTextForMatch(userTextOf(message)) === canonicalText;
  });
  if (duplicateIndex === -1) return [...messages, canonical];
  const merged = [...messages];
  merged[duplicateIndex] = { ...canonical, timestamp: (messages[duplicateIndex] as UserMessage).timestamp };
  return merged;
}

function userTextOf(message: UserMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => block?.type === "text")
    .map((block) => block.text)
    .join("\n");
}
