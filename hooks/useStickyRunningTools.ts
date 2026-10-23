"use client";

import { useEffect, useMemo, useState } from "react";
import {
  mergeRunningToolsWithPinned,
  pinRunningTools,
  type PinnedRunningTool,
  type RunningToolRef,
} from "@/lib/running-tools";

/**
 * 毫秒级工具（read / write / edit）的最短可见时长。
 *
 * 这些工具的 start / end 常常落在同一批事件里，原来的徽章一次都没被画出来；
 * 钉住 700ms 才能让人看见"刚才读过 / 写过文件"。超过 700ms 反而会骗人。
 */
export const RUNNING_TOOL_MIN_VISIBLE_MS = 700;

/**
 * 把「正在跑的工具」补齐成「至少看得见的工具」。
 *
 * 只做一件事：结束时间距现在不足 `minVisibleMs` 的工具继续留在列表里。
 * 全部逻辑都在 `lib/running-tools.ts` 的纯函数里，这里只管定时清理。
 */
export function useStickyRunningTools(
  tools: readonly RunningToolRef[],
  minVisibleMs: number = RUNNING_TOOL_MIN_VISIBLE_MS,
): RunningToolRef[] {
  const [pinned, setPinned] = useState<ReadonlyMap<string, PinnedRunningTool>>(() => new Map());

  useEffect(() => {
    const now = Date.now();
    setPinned((previous) => {
      const next = pinRunningTools(tools, previous, now, minVisibleMs);
      if (next.size !== previous.size) return next;
      for (const [id, value] of next) {
        const before = previous.get(id);
        if (!before || before.until !== value.until || before.name !== value.name) return next;
      }
      return previous;
    });
  }, [tools, minVisibleMs]);

  /** 最早一条「已结束但仍钉住」的到期时间；没有就不排定时器。 */
  const nextExpiry = useMemo(() => {
    const liveIds = new Set(tools.map((tool) => tool.id));
    let earliest = Number.POSITIVE_INFINITY;
    for (const [id, value] of pinned) {
      if (liveIds.has(id)) continue;
      if (value.until < earliest) earliest = value.until;
    }
    return earliest;
  }, [pinned, tools]);

  useEffect(() => {
    if (!Number.isFinite(nextExpiry)) return;
    const delay = Math.max(0, nextExpiry - Date.now()) + 16;
    const timer = setTimeout(() => {
      const now = Date.now();
      setPinned((previous) => pinRunningTools(tools, previous, now, minVisibleMs));
    }, delay);
    return () => clearTimeout(timer);
  }, [nextExpiry, tools, minVisibleMs]);

  return useMemo(() => mergeRunningToolsWithPinned(tools, pinned), [tools, pinned]);
}
