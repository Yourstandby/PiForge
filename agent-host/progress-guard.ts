/**
 * 子 Agent 的「无进展」判定 —— 基于**可观测事件**，而不是"有没有结论"。
 *
 * 旧口径的问题：按"连续 N 轮没有结论"判停，会把**探索性任务**误杀 ——
 * 前几轮只 `read` / `grep` 是正常调研节奏，此时当然没有结论。
 * 新口径：只要这一轮**发生了可观测的动作**（读文件、跑命令、改代码），就算有进展；
 * 连续 `MAX_ROUNDS_WITHOUT_PROGRESS` 轮什么都没有，才判定空转并停下。
 *
 * 两类"动作"的区分很重要：
 *   - `read` / `grep` / `find` / `ls` → **探索**：算进展（说明它在看东西）；
 *   - `bash` / `shell` / `edit` / `write` → **副作用**：算进展，且是最强的进展信号；
 *   - 纯文本回复、`tool_search`、`memory` 读取等元动作 → **不算**进展
 *     （它们不改变"对任务的理解"，只是绕圈）。
 *
 * 纯函数 + 常量，两个 runner（subagents / herdr）共用，方便单测。
 */

/** 连续多少轮没有任何可观测动作就判空转。 */
export const MAX_ROUNDS_WITHOUT_PROGRESS = 5;

/** 算作"有进展"的工具（探索 + 副作用）。 */
export const PROGRESS_TOOLS: ReadonlySet<string> = new Set([
  // 探索
  "read",
  "grep",
  "find",
  "ls",
  "glob",
  "search",
  "web_read",
  "browser_read",
  "web_preview",
  // 副作用
  "edit",
  "write",
  "bash",
  "shell",
  "multiedit",
  "apply_patch",
  "run_bg",
  "pwsh",
  "powershell",
]);

/** 明确不算进展的元动作（列出来是为了让"为什么不算"可读，而不是靠排除法猜）。 */
export const NON_PROGRESS_TOOLS: ReadonlySet<string> = new Set([
  "tool_search",
  "memory",
  "memory_save",
  "memory_search",
  "spawn_agent",
  "herdr_spawn",
  "herdr_status",
  "orchestrator_status",
]);

/** 这个工具事件算不算"有进展"。 */
export function isProgressTool(toolName: string | null | undefined): boolean {
  if (!toolName) return false;
  if (NON_PROGRESS_TOOLS.has(toolName)) return false;
  return PROGRESS_TOOLS.has(toolName);
}

export interface ProgressState {
  /** 连续多少轮（assistant turn）没有出现过任何进展工具。 */
  roundsWithoutProgress: number;
  /** 累计进展事件数（诊断用）。 */
  progressEvents: number;
}

export function initialProgressState(): ProgressState {
  return { roundsWithoutProgress: 0, progressEvents: 0 };
}

/**
 * 处理一轮：`sawProgressTogether` 表示这一轮里是否出现过进展工具。
 * 出现 → 计数清零；没出现 → 累加。
 */
export function advanceProgress(state: ProgressState, sawProgressThisRound: boolean): ProgressState {
  return sawProgressThisRound
    ? { roundsWithoutProgress: 0, progressEvents: state.progressEvents + 1 }
    : { roundsWithoutProgress: state.roundsWithoutProgress + 1, progressEvents: state.progressEvents };
}

export interface ProgressBudget {
  stop: boolean;
  roundsWithoutProgress: number;
  threshold: number;
  reason?: string;
}

/** 该不该因为"空转"而停下。 */
export function checkProgressBudget(
  state: ProgressState,
  threshold: number = MAX_ROUNDS_WITHOUT_PROGRESS,
): ProgressBudget {
  const rounds = Math.max(0, Math.floor(state.roundsWithoutProgress));
  const limit = Math.max(1, Math.floor(threshold));
  if (rounds < limit) return { stop: false, roundsWithoutProgress: rounds, threshold: limit };
  return {
    stop: true,
    roundsWithoutProgress: rounds,
    threshold: limit,
    reason:
      `连续 ${rounds} 轮没有任何文件读取 / 命令执行 / 代码修改` +
      `（阈值 ${limit} 轮）。已按空转中断：请缩小任务范围、给出更具体的入口文件，` +
      "或拆成几个短任务重新派发。",
  };
}
