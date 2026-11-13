"use client";

import { useState } from "react";
import { Check, ChevronDown, ListTodo, Loader2 } from "lucide-react";
import type { PlanProgress } from "@/lib/plan-progress";

/**
 * 计划进度卡片：贴在输入框正上方（不随 Transcript 滚动）。
 *
 * 形态取舍：默认只显示「标题 + 进度条 + 当前这一步」（约 48px 高），
 * 展开才铺全列表 —— 长任务里用户要的是"到哪了"，不是一张清单海报。
 * 全部完成收成一行，把位置还给输入框。
 */
export function PlanProgressCard({
  progress,
  approval,
}: {
  progress: PlanProgress;
  approval?: {
    running: boolean;
    onExecute: () => void;
    onDismiss: () => void;
  } | null;
}) {
  const [open, setOpen] = useState(false);
  const { steps, done, total } = progress;
  const allDone = total > 0 && done === total;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  const current = progress.activeIndex >= 0 ? steps[progress.activeIndex] : null;

  return (
    <div
      role="group"
      aria-label="计划进度"
      className="flex flex-col gap-1.5 rounded-xl border border-[#E6E8EE] bg-white px-2.5 py-2 shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
    >
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-left"
      >
        <ListTodo size={13} strokeWidth={1.9} className="shrink-0 text-accent" aria-hidden="true" />
        <span className="shrink-0 text-[12px] text-ink-soft">计划进度</span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-ink-muted">
          {allDone ? "已完成" : (current?.title ?? "")}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-ink-faint">
          {done}/{total}
        </span>
        <ChevronDown
          size={12}
          strokeWidth={2}
          aria-hidden="true"
          className={
            open
              ? "shrink-0 rotate-180 text-ink-faint transition-transform"
              : "shrink-0 text-ink-faint transition-transform"
          }
        />
      </button>

      <div className="h-[3px] w-full overflow-hidden rounded-full bg-[#EEF0F4]" role="presentation">
        <div
          className={[
            "h-full rounded-full transition-[width] duration-300",
            allDone ? "bg-[#12A150]" : "bg-accent",
          ].join(" ")}
          style={{ width: percent + "%" }}
        />
      </div>

      {open && (
        <ul className="flex flex-col gap-1 pt-0.5">
          {steps.map((step, index) => {
            const active = !allDone && index === progress.activeIndex;
            const isDone = step.status === "done";
            return (
              <li
                key={String(index) + "-" + step.title}
                className="flex items-start gap-1.5 text-[12px] leading-5"
              >
                <span
                  aria-hidden="true"
                  className={[
                    "mt-[3px] flex size-[13px] shrink-0 items-center justify-center rounded-[4px] border",
                    isDone
                      ? "border-accent bg-accent text-white"
                      : active
                        ? "border-accent bg-[#F5F9FF]"
                        : "border-[#D7DBE3] bg-white",
                  ].join(" ")}
                >
                  {isDone ? (
                    <Check size={9} strokeWidth={3.2} />
                  ) : active ? (
                    <Loader2 size={9} strokeWidth={2.6} className="animate-spin text-accent" />
                  ) : null}
                </span>
                <span
                  className={[
                    "min-w-0",
                    isDone ? "text-ink-faint line-through" : active ? "text-ink" : "text-ink-muted",
                  ].join(" ")}
                >
                  {step.title}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {approval && (
        <div className="flex items-center gap-1.5 pt-0.5">
          <button
            type="button"
            onClick={approval.onExecute}
            disabled={approval.running}
            className="rounded-md bg-accent px-2 py-1 text-[11.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            批准并执行
          </button>
          <button
            type="button"
            onClick={approval.onDismiss}
            className="rounded-md px-1.5 py-1 text-[11.5px] text-ink-muted transition-colors hover:bg-[#ECECEF] hover:text-ink"
          >
            拒绝
          </button>
        </div>
      )}
    </div>
  );
}
