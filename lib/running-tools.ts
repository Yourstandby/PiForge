import type { AgentMessage } from "@/lib/types";

export interface RunningToolRef {
  id: string;
  name: string;
}

/** 一条消息里可能出现的两种 toolCall 字段拼法（SDK 落盘版 / 前端归一化版）。 */
type RawBlock = Record<string, unknown>;

function blockType(block: RawBlock): string {
  return typeof block.type === "string" ? block.type : "";
}

function toolCallIdOf(block: RawBlock): string {
  const id = block.toolCallId ?? block.id;
  return typeof id === "string" ? id : "";
}

function toolNameOf(block: RawBlock): string {
  const name = block.toolName ?? block.name;
  return typeof name === "string" ? name.trim() : "";
}

/** 只回看最近这么多条消息：更早的 toolCall 不可能还在跑。 */
const LOOKBACK = 80;

/**
 * 「现在到底有哪些工具在跑」的唯一真相来源。
 *
 * 为什么不能只信 pi 的 `tool_execution_start/end`（也就是 `agentPhase`）：
 * 那是一路事件流，重连重放、agent_host 重启、页面刷新都可能漏掉 start 或 end；
 * 而**消息本身**（toolCall 有、对应 toolResult 没到）是幂等的、随时可从现有状态
 * 重算出来的。所以：
 *
 *   1. 只在 `agentRunning` 时才算（中止后残留的 toolCall 不应显示成"在跑"）；
 *   2. 已经有 toolResult 的 toolCall 一律不算（完成态以消息为准，压过事件流）；
 *   3. `agentPhase` 里有、但消息里还没出现的（刚 start、结果未落盘）也算进来。
 *
 * 结果按 id 去重，名字去重由调用方决定（并行同类工具只显示一次）。
 */
/** 钉住的工具：名字 + 到期时刻（毫秒时间戳）。 */
export interface PinnedRunningTool {
  name: string;
  until: number;
}

/**
 * read / write / edit 这类毫秒级工具，`tool_execution_start` 和 `_end` 常常落在
 * 同一个事件批里（一次 React 渲染就同时 addTool + removeTool），徽章从来没被画出来。
 * 这里给每个出现过的工具钉一个最短可见时限：新 id 记 `now + minVisibleMs`，
 * 已结束但还在时限内的继续留着。纯函数，单测直接覆盖。
 */
export function pinRunningTools(
  live: readonly RunningToolRef[],
  pinned: ReadonlyMap<string, PinnedRunningTool>,
  now: number,
  minVisibleMs: number,
): Map<string, PinnedRunningTool> {
  const next = new Map<string, PinnedRunningTool>();
  for (const tool of live) {
    if (!tool?.id) continue;
    const previous = pinned.get(tool.id);
    next.set(tool.id, {
      name: tool.name,
      until: previous && previous.name === tool.name ? previous.until : now + minVisibleMs,
    });
  }
  for (const [id, value] of pinned) {
    if (next.has(id) || value.until <= now) continue;
    next.set(id, value);
  }
  return next;
}

/**
 * 正在跑的 + 刚结束但还钉着的（按出现顺序，钉住的排在后面）。
 *
 * 不在这里判到期：到期清理交给定时器（`useStickyRunningTools`）。渲染期读
 * `Date.now()` 会污染渲染结果，滞后十几毫秒可见反而是想要的效果。
 */
export function mergeRunningToolsWithPinned(
  live: readonly RunningToolRef[],
  pinned: ReadonlyMap<string, PinnedRunningTool>,
): RunningToolRef[] {
  const merged: RunningToolRef[] = [];
  const seen = new Set<string>();
  for (const tool of live) {
    if (!tool?.id || seen.has(tool.id)) continue;
    seen.add(tool.id);
    merged.push({ id: tool.id, name: tool.name });
  }
  for (const [id, value] of pinned) {
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push({ id, name: value.name });
  }
  return merged;
}

export function collectRunningTools(input: {
  messages: readonly AgentMessage[] | null | undefined;
  phaseTools?: readonly { id?: string; name?: string }[] | null;
  agentRunning: boolean;
}): RunningToolRef[] {
  const { messages, phaseTools, agentRunning } = input;
  if (!agentRunning) return [];

  const resultIds = new Set<string>();
  const calls = new Map<string, RunningToolRef>();

  const list = messages ?? [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index] as unknown as RawBlock;
    if (message?.role === "toolResult") {
      const id = toolCallIdOf(message);
      if (id) resultIds.add(id);
      continue;
    }
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as RawBlock[]) {
      if (!block || blockType(block) !== "toolCall") continue;
      const id = toolCallIdOf(block);
      const name = toolNameOf(block);
      if (!id) continue;
      if (name && !calls.has(id)) calls.set(id, { id, name });
    }
    if (list.length - index > LOOKBACK) break;
  }

  const running: RunningToolRef[] = [];
  const seen = new Set<string>();
  const push = (id: string, name: string) => {
    if (!id || seen.has(id) || resultIds.has(id)) return;
    seen.add(id);
    running.push({ id, name });
  };

  // 消息里"有调用、没结果"的：最可信。倒着扫所以要 reverse 回调用顺序。
  for (const call of Array.from(calls.values()).reverse()) {
    push(call.id, call.name);
  }
  // 事件流里刚 start、结果还没落盘的。
  for (const tool of phaseTools ?? []) {
    const id = typeof tool?.id === "string" ? tool.id : "";
    const name = typeof tool?.name === "string" ? tool.name.trim() : "";
    if (id && name) push(id, name);
  }

  return running;
}

