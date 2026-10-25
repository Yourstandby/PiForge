/**
 * 工具卡片秒表：起止时间挂在模块级 Map（键为 toolCallId），不放在组件里。
 * 组件重挂载（transcript 增量刷新、历史分页懒加载）时起点必须保留，
 * 已跑完的调用要停在真实耗时上，而不是从 0 再数一遍。
 */
export interface ToolClock {
  startedAt?: number;
  endedAt?: number;
  /** 事件流 `tool_execution_end.durationMs`：消息里没有 toolResult 时用它冻结耗时。 */
  durationMs?: number;
}

const TOOL_CLOCK_LIMIT = 2000;
const clocks = new Map<string, ToolClock>();

export function toolClockFor(key: string, limit = TOOL_CLOCK_LIMIT): ToolClock {
  let clock = clocks.get(key);
  if (!clock) {
    if (clocks.size >= limit) clocks.clear();
    clock = {};
    clocks.set(key, clock);
  }
  return clock;
}

/** 完成后冻结耗时：后端 durationMs 优先，否则用自测的起止差。 */
export function settleToolMs(
  durationMs: number | undefined,
  clock: ToolClock | undefined,
): number | undefined {
  const reported =
    typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0
      ? durationMs
      : clock?.durationMs;
  if (typeof reported === "number" && Number.isFinite(reported) && reported >= 0) return reported;
  if (clock?.startedAt === undefined || clock.endedAt === undefined) return undefined;
  return Math.max(0, clock.endedAt - clock.startedAt);
}

/**
 * 事件流报告某次调用已结束：立刻停止这张卡的秒表。
 *
 * 不能只等消息里的 `toolResult`：并行/批量调用时它未必会落到 transcript 能匹配的位置，
 * 卡片就会一直挂在运行态、跟着最新那张一起数下去，显示的不是它自己的结束时间。
 */
export function markToolEnded(toolCallId: string | undefined, durationMs?: number): void {
  if (!toolCallId) return;
  const clock = toolClockFor(toolCallId);
  if (clock.endedAt === undefined) clock.endedAt = Date.now();
  if (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0) {
    clock.durationMs = durationMs;
  }
}

/** 仅供测试：清空注册表。 */
export function resetToolClocks(): void {
  clocks.clear();
}
