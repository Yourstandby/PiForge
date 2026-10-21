import type { AgentMessage, AssistantMessage } from "../../lib/types";

export interface SessionStats {
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    /** 思考/推理 tokens，是 output 的子集；仅提供商上报时存在。 */
    reasoning?: number;
    total?: number;
  };
  cacheHitRate?: number | null;
  cost?: number;
}

/** 单个工具的调用汇总。 */
export interface ToolCallStat {
  name: string;
  count: number;
  errors: number;
}

/** 会话活动：回合数 + 工具调用分布（不依赖 token 用量，零用量时也有值）。 */
export interface SessionActivity {
  /** user 消息数，即对话回合数。 */
  turns: number;
  toolCalls: {
    total: number;
    byTool: ToolCallStat[];
  };
}

export const EMPTY_SESSION_ACTIVITY: SessionActivity = {
  turns: 0,
  toolCalls: { total: 0, byTool: [] },
};

export function calculateSessionStats(messages: AgentMessage[]): SessionStats | null {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let reasoning = 0;
  let cost = 0;

  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const usage = (msg as AssistantMessage).usage;
    if (!usage) continue;
    tokens.input += usage.input ?? 0;
    tokens.output += usage.output ?? 0;
    tokens.cacheRead += usage.cacheRead ?? 0;
    tokens.cacheWrite += usage.cacheWrite ?? 0;
    reasoning += usage.reasoning ?? 0;
    cost += usage.cost?.total ?? 0;
  }

  const total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  if (total === 0) return null;

  const promptTokens = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  const cacheHitRate = promptTokens > 0 ? (tokens.cacheRead / promptTokens) * 100 : undefined;

  return {
    tokens: { ...tokens, ...(reasoning > 0 ? { reasoning } : {}), total },
    cacheHitRate,
    cost,
  };
}

/**
 * 统计会话活动：
 * - turns：一条 user 消息 = 一个回合（与终端 `N turns` 一致）
 * - toolCalls：统计 assistant 内容中的 toolCall 块，并用 toolResult.isError 标记失败次数
 * 与 token 用量无关，所以即使还没有 usage 数据也能展示。
 */
export function calculateSessionActivity(messages: AgentMessage[]): SessionActivity {
  let turns = 0;
  const byName = new Map<string, ToolCallStat>();

  const bump = (rawName: string | undefined) => {
    const name = rawName && rawName.trim() ? rawName : "unknown";
    const entry = byName.get(name) ?? { name, count: 0, errors: 0 };
    entry.count += 1;
    byName.set(name, entry);
    return entry;
  };

  for (const msg of messages) {
    if (msg.role === "user") {
      turns += 1;
      continue;
    }
    if (msg.role === "assistant") {
      const blocks = (msg as AssistantMessage).content;
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks) {
        if ((block as { type?: string }).type === "toolCall") {
          bump((block as { toolName?: string }).toolName);
        }
      }
      continue;
    }
    if (msg.role === "toolResult" && msg.isError && msg.toolName) {
      const entry = byName.get(msg.toolName);
      if (entry) entry.errors += 1;
    }
  }

  const byTool = Array.from(byName.values()).sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name),
  );
  return {
    turns,
    toolCalls: {
      total: byTool.reduce((sum, tool) => sum + tool.count, 0),
      byTool,
    },
  };
}
