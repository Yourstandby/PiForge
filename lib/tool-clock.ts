/**
 * 工具卡片秒表：起止时间挂在模块级 Map（键为 toolCallId），不放在组件里。
 * 组件重挂载（transcript 增量刷新、历史分页懒加载）时起点必须保留，
 * 已跑完的调用要停在真实耗时上，而不是从 0 再数一遍。
 */
export interface ToolClock {
  startedAt?: number;
  endedAt?: number;
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
  if (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0) {
    return durationMs;
  }
  if (clock?.startedAt === undefined || clock.endedAt === undefined) return undefined;
  return Math.max(0, clock.endedAt - clock.startedAt);
}

/** 仅供测试：清空注册表。 */
export function resetToolClocks(): void {
  clocks.clear();
}
