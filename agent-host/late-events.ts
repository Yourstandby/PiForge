/**
 * 被放弃那一轮的「迟到增量」判定。
 *
 * 场景：用户点了「结束」/ 宿主掐掉僵尸流之后，底层的模型流并不会瞬间静默 ——
 * 它可能还会吐几条 `message_update` / `tool_execution_*`。这些事件属于已经
 * 结束的那一轮，投递到界面只会造成两种破坏：
 *   1. 把上一轮的半句话追加到新一轮的气泡里（消息错挂）；
 *   2. 工具卡片在已经结束的轮次里重新变成「执行中」，界面看起来一直忙。
 *
 * 这里只把「增量内容」列为迟到事件；生命周期事件（agent_start / agent_end /
 * agent_settled / agent_error）保持原样投递，否则状态机会卡在 pendingAgentEnd。
 */
const LATE_STREAM_EVENT_TYPES: ReadonlySet<string> = new Set([
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
]);

export function isLateStreamEvent(type: string): boolean {
  return LATE_STREAM_EVENT_TYPES.has(type);
}

/** 新一轮真正开始的事件：收到它就说明放弃窗口可以关了。 */
export function startsNewRun(type: string): boolean {
  return type === "agent_start" || type === "turn_start";
}
