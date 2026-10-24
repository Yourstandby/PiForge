/**
 * 过程分组：把一轮对话里的「思考」与「工具调用」按真实时间顺序折叠成
 * `思考 → 其后的 0..N 个工具` 的组，供 Transcript 渲染「每段思考下方紧跟它
 * 触发的工具调用」。
 *
 * 单独成模块（无 JSX、无 React）是为了能直接跑 `node --test`。
 */

import type { AssistantMessage, ToolResultMessage } from "@/lib/types";

export type RoundProcessThinking = {
  text: string;
  /** 所属 assistant 消息的 usage（用于估算这段思考的 token / 花费）。 */
  usage?: AssistantMessage["usage"];
  /** 树节点 id：支持「从这里分支 / 分叉」。 */
  entryId?: string;
  timestamp?: number;
};

export type RoundProcessTool = {
  block: {
    kind: "tool";
    name: string;
    input: Record<string, unknown>;
    result?: ToolResultMessage;
  };
  usage?: AssistantMessage["usage"];
};

/** 线性扫描的输入项：思考或工具，顺序即真实发生顺序。 */
export type ProcessBlock =
  | { kind: "thinking"; thinking: RoundProcessThinking }
  | { kind: "tool"; tool: RoundProcessTool };

export interface RoundProcessGroup {
  /** 缺省表示「只有工具、没有前置思考」。 */
  thinking?: RoundProcessThinking;
  tools: RoundProcessTool[];
}

export interface RoundProcess {
  groups: RoundProcessGroup[];
}

/** 遇到思考就开新组，遇到工具就挂到当前组（保持时间顺序）。 */
export function groupProcessBlocks(blocks: readonly ProcessBlock[]): RoundProcessGroup[] {
  const groups: RoundProcessGroup[] = [];
  for (const block of blocks) {
    if (block.kind === "thinking") {
      groups.push({ thinking: block.thinking, tools: [] });
      continue;
    }
    // 没有前置思考（模型直接开调），或同一段思考后的连续/并行调用：
    // 挂到当前组；完全没有组时自己开一个，保证「只有工具」的老会话照常显示。
    const current = groups[groups.length - 1];
    if (current) current.tools.push(block.tool);
    else groups.push({ tools: [block.tool] });
  }
  return groups;
}
