"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronRight } from "lucide-react";

export interface DoneTaskItem {
  /** Session-tab key. */
  key: string;
  title: string;
  doneAt: number;
  summary?: string;
}

interface Props {
  items: DoneTaskItem[];
  /** 点击卡片：切到该会话标签（同时视为已读）。 */
  onOpen: (key: string) => void;
  /** 已读 / 自动淡出后彻底清掉该条完成状态。 */
  onRead: (key: string) => void;
}

/** 默认最多同时展示 3 张完成卡片，多出来的排队等位置。 */
const MAX_VISIBLE = 3;
/** 无人理会时，卡片停留多久开始变淡。 */
const AUTO_HIDE_MS = 12_000;
/** 淡出动画时长，动画结束后才算已读。 */
const FADE_MS = 700;

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function DoneCard({
  item,
  fading,
  onSelect,
}: {
  item: DoneTaskItem;
  fading: boolean;
  onSelect: (item: DoneTaskItem) => void;
}) {
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const raf = window.requestAnimationFrame(() => setEntered(true));
    return () => window.cancelAnimationFrame(raf);
  }, []);
  const shown = entered && !fading;
  return (
    <button
      type="button"
      onClick={() => onSelect(item)}
      title={`${item.title} · 点击前往`}
      className={[
        "group pointer-events-auto w-[252px] origin-bottom-right overflow-hidden rounded-xl border border-[#E3E6EB] bg-white px-3 py-2.5 text-left",
        "shadow-[0_10px_30px_-10px_rgba(15,23,42,0.22),0_1px_2px_rgba(15,23,42,0.06)] transition-all ease-out",
        "hover:-translate-y-0.5 hover:border-[#CADCF7] hover:shadow-[0_16px_36px_-12px_rgba(15,23,42,0.3)]",
        shown
          ? "translate-x-0 translate-y-0 scale-100 opacity-100 duration-300"
          : "translate-x-2 translate-y-2 scale-95 opacity-0 duration-500",
      ].join(" ")}
    >
      <div className="flex items-center gap-2">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-[#E9F7EF] text-[#15803D]">
          <Check size={11} strokeWidth={3} aria-hidden="true" />
        </span>
        <span className="text-[11px] font-semibold tracking-[0.01em] text-[#15803D]">任务完成</span>
        <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-[#9AA1AC]">
          {formatTime(item.doneAt)}
        </span>
      </div>
      <div className="mt-1.5 truncate text-[12.5px] font-semibold leading-[18px] text-[#1F2937]">
        {item.title}
      </div>
      <div className="mt-1 flex items-center gap-1 text-[11px] leading-4 text-[#8B93A1]">
        <span className="min-w-0 flex-1 truncate">点击前往该会话</span>
        <ChevronRight
          size={11}
          strokeWidth={2.2}
          aria-hidden="true"
          className="shrink-0 text-[#B4BAC5] transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-[#2563EB]"
        />
      </div>
    </button>
  );
}

export function TaskDoneToasts({ items, onOpen, onRead }: Props) {
  const ordered = useMemo(
    () => [...items].sort((a, b) => a.doneAt - b.doneAt),
    [items],
  );
  // 新完成的排在右侧（从右滑入）；超过上限时只留最近的几个，旧的排队。
  const visible = useMemo(() => ordered.slice(-MAX_VISIBLE), [ordered]);
  const signature = visible.map((item) => item.key).join("|");

  const [fading, setFading] = useState<string[]>([]);
  const timersRef = useRef(new Map<string, number>());
  const onReadRef = useRef(onRead);
  onReadRef.current = onRead;

  // 每张卡片一进来就开始计时，到点变淡。
  useEffect(() => {
    const live = new Map(timersRef.current);
    for (const item of visible) {
      if (live.has(item.key)) continue;
      live.set(
        item.key,
        window.setTimeout(() => {
          setFading((prev) => (prev.includes(item.key) ? prev : [...prev, item.key]));
        }, AUTO_HIDE_MS),
      );
    }
    const ids = new Set(visible.map((item) => item.key));
    for (const [key, timer] of live) {
      if (ids.has(key)) continue;
      window.clearTimeout(timer);
      live.delete(key);
    }
    timersRef.current = live;
    // signature 变化才重新对账；visible 数组本身每次都新建。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  // 变淡的卡片消失后再真正标为已读（动画能播完）。
  const fadingSignature = fading.join("|");
  useEffect(() => {
    if (fading.length === 0) return;
    const ids = new Set(visible.map((item) => item.key));
    const timers = fading
      .filter((key) => ids.has(key))
      .map((key) =>
        window.setTimeout(() => {
          onReadRef.current(key);
          setFading((prev) => prev.filter((item) => item !== key));
        }, FADE_MS),
      );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fadingSignature]);

  // 卡片被移除（切到该会话即已读）后清掉淡出标记，避免残留。
  useEffect(() => {
    const ids = new Set(items.map((item) => item.key));
    setFading((prev) => {
      const next = prev.filter((key) => ids.has(key));
      return next.length === prev.length ? prev : next;
    });
  }, [items]);

  useEffect(() => () => {
    for (const timer of timersRef.current.values()) window.clearTimeout(timer);
    timersRef.current.clear();
  }, []);

  // 点卡片 = 直接跳到那个会话，同时算已读；不再弹任何详情面板。
  const handleSelect = useCallback(
    (item: DoneTaskItem) => {
      onOpen(item.key);
      onRead(item.key);
    },
    [onOpen, onRead],
  );

  if (visible.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-12 right-4 z-40 flex flex-col items-end gap-2">
      {visible.map((item) => (
        <DoneCard
          key={item.key}
          item={item}
          fading={fading.includes(item.key)}
          onSelect={handleSelect}
        />
      ))}
    </div>
  );
}

export default TaskDoneToasts;
