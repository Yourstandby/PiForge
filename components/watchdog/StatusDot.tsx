"use client";

import { useState, type ReactNode } from "react";
import { useWatchdogTask } from "@/hooks/useWatchdogStatus";

export type StatusPointerTone = "stalled" | "failed" | "running";

/**
 * 状态点本体（左栏会话 / 中间标签 / 右栏导航共用）。
 *
 * 悬浮提示用 `position: fixed` + 实时 rect 定位，而不是塞在圆点内部的绝对定位
 * span：左栏会话行和标签条都是 `overflow: hidden`，内部绝对定位的 tooltip 会被
 * 直接裁掉。fixed 不参与祖先的 overflow 裁剪，也就不需要 portal。
 */
export function StatusPointer({
  tone,
  text,
  className = "",
}: {
  tone: StatusPointerTone;
  text: string;
  className?: string;
}) {
  const [tip, setTip] = useState<{ x: number; top: number } | null>(null);

  return (
    <span
      className={`relative flex h-2 w-2 shrink-0 items-center justify-center ${className}`}
      data-tone={tone}
      role="img"
      aria-label={text}
      onMouseEnter={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        setTip({ x: rect.left + rect.width / 2, top: rect.top - 6 });
      }}
      onMouseLeave={() => setTip(null)}
    >
      {tone === "stalled" && (
        <span
          aria-hidden="true"
          className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75"
        />
      )}
      <span
        aria-hidden="true"
        className={`relative inline-flex h-1.5 w-1.5 rounded-full ${
          tone === "running" ? "bg-blue-500" : "bg-red-500"
        }`}
      />
      {tip && (
        <span
          role="tooltip"
          style={{ left: tip.x, top: tip.top }}
          className="pointer-events-none fixed z-[60] -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md bg-[#1F2937] px-1.5 py-0.5 text-[10.5px] leading-4 text-white opacity-95 shadow-sm"
        >
          {text}
        </span>
      )}
    </span>
  );
}

/** 停滞/失败时的一句话提示：不用点进去就知道卡了多久。 */
export function stallTooltip(task: { idleSeconds: number; status: string }): string {
  if (task.status === "failed") {
    return `系统检测到该任务已失败（停滞 ${task.idleSeconds} 秒）`;
  }
  return `系统检测到该任务已停滞 ${task.idleSeconds} 秒`;
}

/**
 * 看门狗状态点（多会话场景的唯一视觉语言）。
 *
 * 三态，颜色无歧义：
 *   - `stalled` → 红色 + `animate-ping` 呼吸（该会话卡住了，需要人管）
 *   - `failed`  → 红色静态（看门狗已放弃，仅界面标记）
 *   - 其它（运行中 / 已完成 / 空闲）→ 不渲染任何东西
 *
 * 为什么做成独立小组件：它自己订阅快照，所以左栏每一条会话、标签栏每一个
 * 标签都只是「一个 8px 的叶子」重渲染，不会把父级（Workbench / 侧边栏 /
 * 聊天区）拖下水 —— 这正是多会话并发时仍能每秒刷新指示灯的前提。
 */
export function WatchdogDot({
  sessionId,
  className = "",
}: {
  sessionId: string | null | undefined;
  className?: string;
}) {
  const task = useWatchdogTask(sessionId ?? null);
  if (!task || (task.status !== "stalled" && task.status !== "failed")) return null;
  return (
    <StatusPointer
      tone={task.status === "stalled" ? "stalled" : "failed"}
      text={stallTooltip(task)}
      className={className}
    />
  );
}

/**
 * 会话标签上的状态灯：看门狗告警优先，其余情况回落到标签自己的活动灯
 * （运行中蓝 / 等待操作琥珀 / 后台已完成绿）。
 *
 * 这样「后台会话卡住 → 左栏红点 → 点过去 → 中间标签也变红」是一条连续的
 * 视觉动线，而不是两套互不相干的指示器。
 */
export function TabStatusLight({
  sessionId,
  fallback,
}: {
  sessionId: string | null | undefined;
  fallback: ReactNode;
}) {
  const task = useWatchdogTask(sessionId ?? null);
  if (task?.status === "stalled" || task?.status === "failed") {
    return <WatchdogDot sessionId={sessionId} />;
  }
  return <>{fallback}</>;
}
