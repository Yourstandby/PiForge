/**
 * 「手动压缩」的前置闸门。
 *
 * 只回答一个问题：**现在点压缩，是「有东西可压」还是「nothing to do」**，并把
 * 「没得压」归成可翻译的原因码。上一版这里直接把内部下标判断的结果抛成
 * `Conversation too short to compact`，于是「会话刚自动压缩过、分支最后一条就是
 * 压缩条目」这种完全正常的情况会显示成刺眼的「压缩失败」——其实什么也没坏，
 * 只是没有新历史可压（pi 自己对同一状态抛的是 `Already compacted`）。
 *
 * 注意口径差异：这里用 raw `getBranch()` + `findCutPoint` 做**保守预检**（这两个是
 * pi 包根导出的，`prepareCompaction` 没导出，不做深路径 import——bundle 里重复一份
 * session 投影模块得不偿失）。pi 内部还会在压缩感知投影上再判一次，那种「我们放行、
 * pi 说没得压」的少数情况（被 `context_edit` 改写的条目等）由调用方 catch 住
 * `compactSkipReasonFromError` 折成同样的 no-op，不会当作失败抛给用户。
 */
import { findCutPoint } from "./sdk-adapter.ts";

/** 为什么这条会话现在没有可压缩的历史。 */
export type CompactSkipReason = "already_compacted" | "too_short";

interface GateSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

/**
 * 能压返回 null；不能压返回原因码。
 *
 * `already_compacted`：分支最后一条就是压缩条目（自动压缩在 `agent_settled` 压完，
 * 之后还没有新消息写盘）。
 * `too_short`：上一次压缩之后攒下来的历史还不够一次压缩的成本。
 */
export function compactSkipReason(
  branchEntries: readonly unknown[],
  settings: GateSettings,
): CompactSkipReason | null {
  const entries = branchEntries as Array<{ type: string }>;
  if (entries.length === 0) return "too_short";
  if (entries[entries.length - 1]?.type === "compaction") return "already_compacted";

  let prevCompactionIndex = -1;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i].type === "compaction") {
      prevCompactionIndex = i;
      break;
    }
  }
  const boundaryStart = prevCompactionIndex + 1;
  const cutPoint = findCutPoint(entries as never, boundaryStart, entries.length, settings.keepRecentTokens);
  const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
  return historyEnd <= boundaryStart ? "too_short" : null;
}

/**
 * 把 pi 抛出来的英文错误折回原因码（预检与真正调用之间分支可能变化，例如上一轮
 * 刚好 settled 追加了压缩条目）。
 */
export function compactSkipReasonFromError(message: string): CompactSkipReason | null {
  if (/already\s+compacted/i.test(message)) return "already_compacted";
  if (/nothing to compact|too short to compact/i.test(message)) return "too_short";
  return null;
}
