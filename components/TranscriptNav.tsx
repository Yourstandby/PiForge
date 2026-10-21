"use client";

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

export interface TranscriptNavItem {
  /** 消息锚点 id（来自 Transcript 的 `id="turn-N"`）。 */
  id: string;
  /** 面板里单行截断显示的文字。 */
  text: string;
}

export interface TranscriptNavProps {
  /** 全量历史提问（卡片直接渲染它，可随意滚动）。 */
  items: TranscriptNavItem[];
  /** 轨道上 9 个刻度对应的 items 下标；缺省时取前 9 条。 */
  ticks?: number[];
  /** 轨道窗口内的高亮下标（0..8）。 */
  activeIndex?: number;
  /** 全量列表里的高亮下标（卡片用）。 */
  activeItemIndex?: number;
  onJump?: (index: number) => void;
}

/** 卡片与刻度最多渲染的条数（防止长会话撑出上百个 DOM 节点）。 */
const MAX_ITEMS = 9;
const HIDE_DELAY = 180;

type TipState = { text: string; top: number; left: number };

/* -------------------------------------------------------------------------- */
/* 卡片：纯展示 + memo，hover 产生的 tip 状态变化不会让它重渲染 */
/* -------------------------------------------------------------------------- */

interface NavCardProps {
  items: TranscriptNavItem[];
  /** 轨道窗口内的下标（0..8）。 */
  activeIndex: number;
  /** 全量列表里的绝对下标（卡片渲染全部记录时用它高亮）。 */
  activeItemIndex?: number;
  isHovered: boolean;
  onJump: (index: number) => void;
  onItemEnter: (element: HTMLElement, text: string) => void;
  onItemLeave: () => void;
}

const NavCard = memo(function NavCard({
  items,
  activeIndex,
  activeItemIndex,
  isHovered,
  onJump,
  onItemEnter,
  onItemLeave,
}: NavCardProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const activeRow = activeItemIndex ?? activeIndex;

  /** 卡片出现时，把当前高亮项滚进可视区（一眼看到自己在哪）。 */
  useEffect(() => {
    if (!isHovered) return;
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    el?.scrollIntoView({ block: "nearest" });
  }, [isHovered, activeRow]);

  /** 滚轮留在卡片内部：列表能滚就只滚列表，不把事件冒泡给背后的聊天区。 */
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      const scrollable = el.scrollHeight - el.clientHeight > 1;
      if (!scrollable) return;
      event.preventDefault();
      event.stopPropagation();
      el.scrollTop += event.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  return (
    /* 外层：只负责定位 / 圆角 / 阴影 / 淡入淡出，绝不承载滚动 */
    <div
      className={`
        absolute right-[100%] top-1/2 -translate-y-1/2 mr-2
        flex w-[200px] max-h-[240px] flex-col overflow-hidden
        rounded-xl bg-white/80 shadow-[0_4px_20px_rgba(0,0,0,0.05)] backdrop-blur-md
        transform-gpu will-change-transform
        transition-[opacity,transform] duration-200 origin-right
        ${isHovered ? "opacity-100 translate-x-0 pointer-events-auto" : "opacity-0 translate-x-4 pointer-events-none"}
      `}
    >
      {/* 内层：唯一真正滚动的容器，4px 极简滚动条直接写在这里 */}
      <div
        ref={listRef}
        onWheel={(event) => event.stopPropagation()}
        className={`
          flex-1 overflow-y-auto overscroll-contain px-2 py-1
          [&::-webkit-scrollbar]:w-[3px]
          [&::-webkit-scrollbar-track]:bg-transparent
          [&::-webkit-scrollbar-thumb]:rounded-full
          [&::-webkit-scrollbar-thumb]:bg-gray-300/30
          hover:[&::-webkit-scrollbar-thumb]:bg-gray-400/60
          [&::-webkit-scrollbar-button]:hidden
        `}
      >
        {items.map((item, idx) => (
          <button
            key={item.id}
            type="button"
            data-active={activeRow === idx ? "true" : undefined}
            onMouseEnter={(event) => onItemEnter(event.currentTarget, item.text)}
            onMouseLeave={onItemLeave}
            onClick={() => onJump(idx)}
            className={`
              my-0.5 flex w-full items-center rounded-md px-2 py-1.5
              text-left text-[12px]
              ${
                activeRow === idx
                  ? "bg-blue-50 font-normal text-blue-500"
                  : "text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              }
            `}
          >
            {/* 单行截断必须落在文本节点本身的块级子元素上，flex 容器上的 truncate 不生效 */}
            <span className="min-w-0 flex-1 truncate whitespace-nowrap">{item.text}</span>
          </button>
        ))}
      </div>
    </div>
  );
});

/* -------------------------------------------------------------------------- */
/* 轨道：9 个刻度，高亮直接在小横条本身上切换 */
/* -------------------------------------------------------------------------- */

const NavRail = memo(function NavRail({
  items,
  ticks,
  activeIndex,
  onJump,
}: {
  items: TranscriptNavItem[];
  ticks: number[];
  activeIndex: number;
  onJump: (index: number) => void;
}) {
  return (
    /* 热区：-m-4 + p-4 把感应范围向外扩 16px（视觉位置不变），
       鼠标划过横条附近就会淡入卡片。 */
    <div className="relative -m-4 flex flex-col items-center gap-[18px] p-4">
      {ticks.map((position, index) => {
        const isActive = activeIndex === index;
        return (
          <div
            key={items[position]?.id ?? position}
            onClick={() => onJump(position)}
            role="button"
            tabIndex={-1}
            aria-label={items[position]?.text}
            aria-current={isActive ? "true" : undefined}
            /* 同一个元素切换 class：宽度/颜色都在它自身上过渡，
               不存在"两套 DOM 各算一套绝对定位"导致的重合误差。 */
            className={`h-[3px] cursor-pointer rounded-full transition-all duration-200 ease-out ${
              isActive ? "w-3 bg-blue-500" : "w-1.5 bg-gray-300 hover:bg-gray-400"
            }`}
          />
        );
      })}
    </div>
  );
});

/* -------------------------------------------------------------------------- */
/* Tooltip：独立浮动层，portal 到 body，卡片内容不受它影响 */
/* -------------------------------------------------------------------------- */

const NavTooltip = memo(function NavTooltip({ tip }: { tip: TipState | null }) {
  if (!tip || typeof document === "undefined") return null;
  return createPortal(
    <div
      role="tooltip"
      style={{ top: tip.top, left: tip.left }}
      className="pointer-events-none transform-gpu fixed z-[60] w-max max-w-[280px] -translate-x-full -translate-y-1/2 whitespace-pre-wrap break-words rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-[12px] leading-relaxed text-gray-700 shadow-[0_4px_16px_rgba(17,17,17,0.12)]"
    >
      {tip.text}
    </div>,
    document.body,
  );
});

/* -------------------------------------------------------------------------- */

/** memo：父级（ChatSurface）每帧重渲染时，导航只在 items/activeIndex 变化时才重绘。 */
export const TranscriptNav = memo(function TranscriptNav({
  items,
  ticks,
  activeIndex = 0,
  activeItemIndex,
  onJump,
}: TranscriptNavProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [tip, setTip] = useState<TipState | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 轨道刻度：默认取前 9 条；父级给了 ticks 就用它（窗口滑动时跟随）。 */
  const tickPositions = useMemo(
    () => (ticks && ticks.length > 0 ? ticks : items.slice(0, MAX_ITEMS).map((_, index) => index)),
    [ticks, items],
  );

  /* 悬浮意图：进入立即展开，离开延迟 HIDE_DELAY 收起（可被再次进入取消） */
  const show = useCallback(() => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    setIsHovered(true);
  }, []);

  const hide = useCallback(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      hideTimerRef.current = null;
      setIsHovered(false);
      setTip(null);
    }, HIDE_DELAY);
  }, []);

  useEffect(
    () => () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    },
    [],
  );

  /* 开发期定位自检：确认参照物确实是中间聊天面板，而不是窗口。 */
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const el = containerRef.current;
    if (!el) return;
    const parent = el.offsetParent as HTMLElement | null;
    console.debug("[nav] position check", {
      navRight: Math.round(el.getBoundingClientRect().right),
      parentRight: parent ? Math.round(parent.getBoundingClientRect().right) : null,
      parentClass: parent?.className ?? null,
    });
  }, []);

  /** 每次 mouseenter 只读一次 rect（纯读，不写布局，不产生 forced reflow）。 */
  const showTip = useCallback((element: HTMLElement, text: string) => {
    if (!text) return;
    const rect = element.getBoundingClientRect();
    const next = { text, top: rect.top + rect.height / 2, left: rect.left - 6 };
    setTip((prev) => (prev && prev.text === text && prev.top === next.top && prev.left === next.left ? prev : next));
  }, []);

  const hideTip = useCallback(() => setTip(null), []);

  /** 跳转 + 收起提示；handler 引用稳定，保证 NavCard / NavRail 的 memo 生效。 */
  const handleJump = useCallback(
    (index: number) => {
      setTip(null);
      onJump?.(index);
    },
    [onJump],
  );

  return (
    <div
      ref={containerRef}
      /* 贴在**中间聊天面板**的右边缘（父级 ChatSurface 的 relative 容器），
         而不是整个窗口右侧 —— 否则右侧面板一展开，横条就飘到终端里去了。 */
      className="absolute right-2 top-1/2 z-50 -translate-y-1/2"
      onMouseEnter={show}
      onMouseLeave={hide}
    >
      <NavCard
        items={items}
        activeIndex={activeIndex}
        activeItemIndex={activeItemIndex}
        isHovered={isHovered}
        onJump={handleJump}
        onItemEnter={showTip}
        onItemLeave={hideTip}
      />

      <NavRail items={items} ticks={tickPositions} activeIndex={activeIndex} onJump={handleJump} />

      <NavTooltip tip={tip} />
    </div>
  );
});

export default TranscriptNav;
