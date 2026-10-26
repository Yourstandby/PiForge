"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, PanelLeftOpen, PanelRightOpen, Plus, X } from "lucide-react";
import { projectNameFromCwd } from "@/lib/project-name";
import { ProjectTintDot } from "./ProjectTintDot";
import { TabStatusLight } from "./watchdog/StatusDot";

/**
 * Browser-style tab strip for the middle chat column.
 *
 * Each open tab owns a mounted ChatSurface (state, stream and draft survive
 * switching), so this component stays presentational: it only reports which tab
 * was selected, closed, or that a new one is wanted.
 */
/** 后台标签的实时状态，用于标题左侧的状态指示灯。 */
export type SessionTabStatus = "none" | "running" | "waiting" | "done";

export interface SessionTabItem {
  key: string;
  title: string;
  /** Null for a not-yet-created session tab ("新会话"). */
  sessionId: string | null;
  /** Project directory of the session; rendered as a breadcrumb before the title. */
  cwd: string | null;
  /** 运行中 / 等待用户处理 / 后台已完成未读 / 普通。 */
  status?: SessionTabStatus;
}

const STATUS_META: Record<
  Exclude<SessionTabStatus, "none">,
  { className: string; label: string }
> = {
  running: { className: "bg-accent animate-pulse", label: "运行中" },
  waiting: { className: "bg-warning", label: "等待你的操作" },
  done: { className: "bg-success", label: "后台已完成，尚未查看" },
};

interface Props {
  tabs: SessionTabItem[];
  activeKey: string | null;
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
  onNew: () => void;
  /** 左侧会话栏已收起：在标签栏最左侧显示「展开左侧栏」。 */
  leftCollapsed?: boolean;
  onExpandLeft?: () => void;
  /** 右侧面板已收起：在「+」旁显示「展开右侧面板」。 */
  rightCollapsed?: boolean;
  onExpandRight?: () => void;
}

const ICON_BUTTON_CLASS =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[#6B7280] transition-colors hover:bg-[#E8EFFB] hover:text-[#2563EB]";

export function SessionTabBar({
  tabs,
  activeKey,
  onSelect,
  onClose,
  onNew,
  leftCollapsed = false,
  onExpandLeft,
  rightCollapsed = false,
  onExpandRight,
}: Props) {
  const [hovered, setHovered] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // 溢出时在两端显示箭头（替代纯渐变提示），并让滚轮/触控板都能横向滚动
  const [edges, setEdges] = useState({ left: false, right: false });

  const syncEdges = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setEdges((previous) => {
      const next = { left: el.scrollLeft > 2, right: max > 2 && el.scrollLeft < max - 2 };
      return previous.left === next.left && previous.right === next.right ? previous : next;
    });
  }, []);

  const scrollByStep = useCallback((direction: 1 | -1) => {
    const el = listRef.current;
    if (!el) return;
    el.scrollBy({ left: direction * Math.max(120, el.clientWidth * 0.7), behavior: "smooth" });
  }, []);

  useEffect(() => {
    syncEdges();
    window.addEventListener("resize", syncEdges);
    const el = listRef.current;
    // 普通鼠标滚轮默认只滚纵向：拦下来转成横向滚动（passive:false 才能 preventDefault）
    const onWheel = (event: WheelEvent) => {
      const target = listRef.current;
      if (!target) return;
      if (target.scrollWidth <= target.clientWidth) return;
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return; // 触控板横向手势交给原生
      target.scrollLeft += event.deltaY;
      event.preventDefault();
    };
    el?.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("resize", syncEdges);
      el?.removeEventListener("wheel", onWheel);
    };
  }, [syncEdges, tabs.length]);

  // 切换（含 Ctrl+Tab / 新建标签）后把活动标签滚进视野
  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    active?.scrollIntoView({ inline: "nearest", block: "nearest" });
    syncEdges();
  }, [activeKey, tabs.length, syncEdges]);


  return (
    <div className="flex h-9 min-w-0 shrink-0 items-stretch gap-0.5 overflow-hidden border-b border-[#E7E9EE] bg-[#F7F7F9] px-1.5 pt-1">
      {/* 左：展开左侧栏（仅在收起时出现），风格与其它图标按钮一致 */}
      {leftCollapsed && onExpandLeft && (
        <button
          type="button"
          onClick={onExpandLeft}
          aria-label="展开左侧边栏"
          title="展开左侧边栏"
          className={`mb-0.5 self-center ${ICON_BUTTON_CLASS}`}
        >
          <PanelLeftOpen size={15} strokeWidth={1.75} aria-hidden="true" />
        </button>
      )}

      {/* 溢出时两端出现箭头：点击平滑滚动露出隐藏标签 */}
      {edges.left && (
        <button
          type="button"
          onClick={() => scrollByStep(-1)}
          aria-label="向左滚动标签"
          title="向左滚动标签"
          className="mb-0.5 flex w-5 shrink-0 items-center justify-center self-center rounded text-[#9CA3AF] transition-colors hover:bg-[#E8EFFB] hover:text-[#2563EB]"
        >
          <ChevronLeft size={13} strokeWidth={2.2} aria-hidden="true" />
        </button>
      )}

      {/* 横向滚动（隐藏滚动条 + 滚轮转换）：标签再多也只会滚动，不会撑破容器 */}
      <div
        ref={listRef}
        role="tablist"
        aria-label="会话标签"
        onScroll={syncEdges}
        className="scrollbar-none relative flex min-w-0 flex-1 flex-nowrap items-stretch gap-0.5 overflow-x-auto overflow-y-hidden overscroll-x-contain scroll-smooth"
      >
        {tabs.map((tab) => {
          const active = tab.key === activeKey;
          // 只用色块区分项目，标题不再带文字前缀；项目名放进 title
          const project = projectNameFromCwd(tab.cwd);
          const status = tab.status ?? "none";
          const statusMeta = status === "none" ? null : STATUS_META[status];
          return (
            <div
              key={tab.key}
              role="tab"
              aria-selected={active}
              data-active={active ? "true" : undefined}
              tabIndex={0}
              onClick={() => onSelect(tab.key)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(tab.key);
                }
              }}
              onMouseEnter={() => setHovered(tab.key)}
              onMouseLeave={() => setHovered(null)}
              onAuxClick={(event) => {
                if (event.button === 1) onClose(tab.key);
              }}
              title={[project, tab.cwd, tab.title].filter(Boolean).join(" · ")}
              className={`group flex h-8 max-w-[268px] min-w-[112px] shrink-0 cursor-pointer items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-sm pl-2 pr-1 text-[12.5px] transition-[background-color,color,box-shadow] duration-150 ease-out ${
                active
                  ? "font-semibold text-[#1F2937] shadow-[inset_0_-2px_0_#2563EB]"
                  : "text-[#6B7280] hover:bg-[#EFEFF2] hover:text-[#374151]"
              }`}
            >
              {/* 极简面包屑：项目名（暗）+ 分隔斜杠 + 会话标题；只用字重与明度区分活动标签 */}
              {tab.cwd && (
                <span className="flex shrink-0 items-center gap-1 text-[11.5px] font-normal text-[#9CA3AF]">
                  <ProjectTintDot cwd={tab.cwd} />
                  {project && <span className="max-w-[96px] truncate">{project}</span>}
                  {project && <span className="opacity-60">/</span>}
                </span>
              )}
              {/* 状态指示灯：看门狗红灯优先；否则运行中（蓝）/ 等待操作（琥珀）/ 后台已完成（绿）。
                  看门狗那部分是独立订阅的叶子组件，切标签不会牵动整条标签栏重渲染。 */}
              <TabStatusLight
                sessionId={tab.sessionId}
                fallback={
                  statusMeta ? (
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusMeta.className}`}
                      role="img"
                      aria-label={statusMeta.label}
                      title={statusMeta.label}
                    />
                  ) : null
                }
              />
              <span className="min-w-0 flex-1 truncate">{tab.title}</span>
              <button
                type="button"
                aria-label={`关闭 ${tab.title}`}
                title="关闭"
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(tab.key);
                }}
                className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded transition-colors ${
                  hovered === tab.key || active
                    ? "text-[#9CA3AF] hover:bg-[#E8EFFB] hover:text-[#2563EB]"
                    : "text-transparent"
                }`}
              >
                <X size={11} strokeWidth={2.2} aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>

      {edges.right && (
        <button
          type="button"
          onClick={() => scrollByStep(1)}
          aria-label="向右滚动标签"
          title="向右滚动标签"
          className="mb-0.5 flex w-5 shrink-0 items-center justify-center self-center rounded text-[#9CA3AF] transition-colors hover:bg-[#E8EFFB] hover:text-[#2563EB]"
        >
          <ChevronRight size={13} strokeWidth={2.2} aria-hidden="true" />
        </button>
      )}

      {/* 右：展开右侧面板（仅在收起时出现）+ 新建标签，二者都固定在最右 */}
      {rightCollapsed && onExpandRight && (
        <button
          type="button"
          onClick={onExpandRight}
          aria-label="展开右侧面板"
          title="展开右侧面板"
          className={`mb-0.5 ml-0.5 self-center ${ICON_BUTTON_CLASS}`}
        >
          <PanelRightOpen size={15} strokeWidth={1.75} aria-hidden="true" />
        </button>
      )}

      <button
        type="button"
        onClick={onNew}
        title="新建会话标签"
        aria-label="新建会话标签"
        className={`mb-0.5 ml-0.5 self-center ${ICON_BUTTON_CLASS}`}
      >
        <Plus size={14} strokeWidth={2} aria-hidden="true" />
      </button>
    </div>
  );
}

export default SessionTabBar;
