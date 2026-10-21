/**
 * Sub-agent 列表的客户端归并逻辑（纯函数，便于单测）。
 *
 * 数据来源有两条：
 *   1. SSE 帧里的 `agents`（Host 的权威快照，完整 output / verification / duration）；
 *   2. 同一帧里的 `events`（生命周期增量：started / output / finished）。
 * 正常路径快照就够，但 Host 的广播是按 250ms 合并的，快照可能比事件晚一点点；
 * 增量事件用来「先把卡片补上 / 先改状态」，保证新拉起的子 Agent 立刻出现在最上面。
 */
import type {
  SubagentLifecycleEvent,
  SubagentStatus,
  SubagentToolCallView,
  SubagentView,
} from "@contract/domains/subagents";

/** 运行中的排最前；同等状态按开始时间倒序 —— 新拉起的永远在最上面。 */
const STATUS_RANK: Record<SubagentStatus, number> = {
  running: 0,
  completed: 1,
  failed: 1,
  cancelled: 1,
};

export function sortSubagents(agents: readonly SubagentView[]): SubagentView[] {
  return [...agents].sort((a, b) => {
    const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (rank !== 0) return rank;
    if (b.startedAt !== a.startedAt) return b.startedAt - a.startedAt;
    // 同一毫秒启动的用 id 兜底，保证顺序稳定（否则卡片会来回跳）。
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function upsertToolCall(
  calls: readonly SubagentToolCallView[],
  incoming: SubagentToolCallView,
): SubagentToolCallView[] {
  const index = calls.findIndex((call) => call.id === incoming.id);
  if (index < 0) return [...calls, incoming];
  const next = [...calls];
  next[index] = { ...next[index], ...incoming };
  return next;
}

/** 追加流式文本；快照里已经包含这段（权威数据覆盖了增量）就不重复追加。 */
function mergeOutput(current: string, incoming: string): string {
  const text = incoming.trim();
  if (!text) return current;
  if (!current) return text;
  if (current.includes(text)) return current;
  return `${current}\n\n${text}`;
}

function isFinished(agent: SubagentView): boolean {
  return agent.status !== "running" || agent.endedAt !== null;
}

function upsert(agents: readonly SubagentView[], incoming: SubagentView): SubagentView[] {
  const index = agents.findIndex((agent) => agent.id === incoming.id);
  if (index < 0) return [incoming, ...agents];
  const next = [...agents];
  next[index] = { ...next[index], ...incoming };
  return next;
}

/** 把一条生命周期事件合并进列表（幂等，且不会把已结束的卡片打回 running）。 */
export function applySubagentEvent(
  agents: readonly SubagentView[],
  event: SubagentLifecycleEvent,
): SubagentView[] {
  if (event.type === "subagent_started") {
    const existing = agents.find((agent) => agent.id === event.agent.id);
    // 事件重放 / 乱序：已经结束的卡片不允许被 started 覆盖回 running。
    if (existing && isFinished(existing)) return [...agents];
    return upsert(agents, event.agent);
  }
  if (event.type === "subagent_finished") {
    return upsert(agents, event.agent);
  }
  // subagent_output：只更新已存在的卡片（缺 started 时由快照补上）。
  const index = agents.findIndex((agent) => agent.id === event.id);
  if (index < 0) return [...agents];
  const current = agents[index];
  const next = [...agents];
  next[index] = {
    ...current,
    name: event.name || current.name,
    output: mergeOutput(current.output, event.text),
    toolCalls: event.toolCall ? upsertToolCall(current.toolCalls, event.toolCall) : current.toolCalls,
  };
  return next;
}

export function applySubagentEvents(
  agents: readonly SubagentView[],
  events: readonly SubagentLifecycleEvent[] | undefined,
): SubagentView[] {
  if (!events || events.length === 0) return [...agents];
  return events.reduce<SubagentView[]>((acc, event) => applySubagentEvent(acc, event), [...agents]);
}

/**
 * SSE 帧 → 新列表。
 * 快照（`agents`）是权威的：Host 侧删除 / 裁剪 / 结束都以它为准；
 * 增量事件只用来补齐快照里还没出现的 id。
 */
export function mergeSubagentFrame(
  previous: readonly SubagentView[],
  frame: { agents?: readonly SubagentView[]; events?: readonly SubagentLifecycleEvent[] },
): SubagentView[] {
  const base = frame.agents ?? previous;
  return sortSubagents(applySubagentEvents([...base], frame.events));
}
