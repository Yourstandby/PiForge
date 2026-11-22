"use client";

import { useState } from "react";
import { Check, ChevronDown, ListTodo, Loader2, Minus } from "lucide-react";
import {
  planRemainingSteps,
  planSettlement,
  type PlanProgress,
} from "@/lib/plan-progress";

/**
 * 计划进度卡片：贴在输入框正上方（不随 Transcript 滚动）。
 *
 * 形态取舍：默认只显示「标题 + 进度条 + 当前这一步」（约 48px 高），
 * 展开才铺全列表 —— 长任务里用户要的是"到哪了"，不是一张清单海报。
 * 全部完成收成一行，把位置还给输入框。
 */
export function PlanProgressCard({
  progress,
  running = true,
  approval,
  onResume,
  onAbandon,
}: {
  progress: PlanProgress;
  /**
   * 这一轮是否还在跑。false 时把残留的 active 步骤判为「状态没收尾」：
   * 模型常常把第 1 步标成 active 之后只推进了后面几步，从没回填 done，
   * 卡片就会永远 4/5 转圈 —— 看起来像任务卡死，其实早跑完了。
   * 缺省 true，保持没有传这个 prop 时的旧行为。
   */
  running?: boolean;
  approval?: {
    running: boolean;
    onExecute: () => void;
    onDismiss: () => void;
  } | null;
  /**
   * 结算出口。计划停在半路时这张卡片**必须**有下一步动作可点，
   * 否则它就只是"提醒你还有事没做"，然后一起被无视。
   */
  onResume?: () => void;
  onAbandon?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { steps, done, dropped, total } = progress;
  const allDone = total > 0 && done === total;
  /** open = 还有没做完的步：这才是需要结算的状态。 */
  const settlement = planSettlement(progress);
  const settled = settlement !== "open";
  const remaining = planRemainingSteps(progress);
  /** 未结算 + 本轮已停机 = 计划被搁置（本来什么都不显示，卡就烂在那里）。 */
  const halted = !settled && !running;
  const canSettle = halted && Boolean(onResume || onAbandon);
  /** 真的在推进：有 spinner 才转。 */
  const live = !allDone && running;

  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  const current = progress.activeIndex >= 0 ? steps[progress.activeIndex] : null;

  return (
    <div
      role="group"
      aria-label={halted ? "计划进度（未完成）" : "计划进度"}
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
          {settlement === "done"
            ? "已完成"
            : settlement === "dropped"
              ? "已放弃"
              : settlement === "partial"
                ? "已收尾（放弃 " + dropped + " 步）"
                : (current?.title ?? "")}
        </span>
        {halted ? (
          <span className="shrink-0 rounded-[4px] bg-[#FFF4E5] px-1 text-[10.5px] leading-[15px] text-[#9A5B00]">
            未完成
          </span>
        ) : null}
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
            allDone
              ? "bg-[#12A150]"
              : settlement === "dropped"
                ? "bg-[#9AA1AE]"
                : settlement === "partial"
                  ? "bg-[#12A150]"
                  : "bg-accent",
          ].join(" ")}
          style={{ width: percent + "%" }}
        />
      </div>

      {open && (
        <ul className="flex flex-col gap-1 pt-0.5">
          {steps.map((step, index) => {
            const active = !allDone && index === progress.activeIndex;
            const isDone = step.status === "done";
            const isDropped = step.status === "dropped";
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
                      : isDropped
                        ? "border-[#D7DBE3] bg-[#F1F2F5] text-ink-faint"
                        : active
                          ? "border-accent bg-[#F5F9FF]"
                          : "border-[#D7DBE3] bg-white",
                  ].join(" ")}
                >
                  {isDone ? (
                    <Check size={9} strokeWidth={3.2} />
                  ) : isDropped ? (
                    <Minus size={9} strokeWidth={3} />
                  ) : active && live ? (
                    <Loader2 size={9} strokeWidth={2.6} className="animate-spin text-accent" />
                  ) : active ? (
                    <span className="size-[4px] rounded-full bg-ink-faint" />
                  ) : null}
                </span>
                <span
                  className={[
                    "min-w-0",
                    isDone || isDropped
                      ? "text-ink-faint line-through"
                      : active && live
                        ? "text-ink"
                        : "text-ink-muted",
                  ].join(" ")}
                >
                  {step.title}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {!approval && canSettle && (
        <div className="flex items-center gap-1.5 pt-0.5">
          <span className="min-w-0 flex-1 truncate text-[11px] text-ink-faint">
            还剩 {remaining.length} 步未结算
          </span>
          {onResume && (
            <button
              type="button"
              onClick={onResume}
              className="shrink-0 rounded-md border border-[#D9E5FB] bg-[#F5F9FF] px-2 py-1 text-[11.5px] font-medium text-accent transition-colors hover:bg-[#EAF2FF]"
            >
              继续执行
            </button>
          )}
          {onAbandon && (
            <button
              type="button"
              onClick={onAbandon}
              className="shrink-0 rounded-md px-1.5 py-1 text-[11.5px] text-ink-muted transition-colors hover:bg-[#ECECEF] hover:text-ink"
            >
              放弃剩余
            </button>
          )}
        </div>
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
