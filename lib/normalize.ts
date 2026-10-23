import { expandDomainToolCall } from "./domain-tools.ts";
import type { AgentMessage, ToolCallContent } from "./types.ts";

export function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

function normalizeToolCallBlock(block: unknown): ToolCallContent | null {
  if (!isObject(block) || block.type !== "toolCall") return null;
  return {
    type: "toolCall",
    toolCallId: typeof block.toolCallId === "string" ? block.toolCallId : (typeof block.id === "string" ? block.id : ""),
    toolName: typeof block.toolName === "string" ? block.toolName : (typeof block.name === "string" ? block.name : ""),
    input: typeof block.input === "object" && block.input !== null && !Array.isArray(block.input)
      ? block.input as Record<string, unknown>
      : (typeof block.arguments === "object" && block.arguments !== null && !Array.isArray(block.arguments)
        ? block.arguments as Record<string, unknown>
        : {}),
  };
}

/**
 * 多态工具调用 → 旧工具调用（`shell{action:"run"}` → `run_bg{...}`）。
 *
 * 归一化放在这一处：Transcript / 运行指示器 / 图标 / i18n / 审批摘要全都按旧名字
 * 工作，合并工具后它们的渲染与文案一个字都不用改。
 */
function expandDomainCall(call: ToolCallContent): ToolCallContent {
  const expanded = expandDomainToolCall(call.toolName, call.input ?? {});
  if (!expanded) return call;
  return { ...call, toolName: expanded.toolName, input: expanded.input };
}

export function normalizeToolCalls(msg: AgentMessage): AgentMessage {
  if (msg.role !== "assistant") return msg;
  const content = msg.content;
  if (!Array.isArray(content)) return msg;
  const normalized = content.map((block) => {
    const result = normalizeToolCallBlock(block);
    return result ? expandDomainCall(result) : block;
  });
  return { ...msg, content: normalized };
}