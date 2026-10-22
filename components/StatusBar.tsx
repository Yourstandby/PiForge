"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  BookOpen,
  Check,
  ChevronDown,
  FileArchive,
  Folder,
  Gauge,
  GitCompare,
  ListTodo,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  Volume2,
  VolumeX,
} from "lucide-react";
import { ModelSelector } from "./chat-input/ModelSelector";
import { getThinkingLevelsForModel } from "./chat-input/thinking-levels";
import { StatsBar, type ContextUsage, type SessionStats } from "./StatsBar";
import type { SessionActivity } from "@/hooks/agent-session/session-stats";
import { useDismissOnOutsideClick } from "@/hooks/useDismissOnOutsideClick";
import type { AgentMode } from "@/lib/approval-policy";
import { projectNameFromCwd } from "@/lib/project-name";

export type ThinkingLevel =
  | "auto"
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

const AGENT_MODE_OPTIONS: Array<{
  value: AgentMode;
  label: string;
  description: string;
  Icon: typeof ShieldCheck;
}> = [
  { value: "full", label: "完全访问", description: "工具直接执行，不再逐次确认", Icon: ShieldCheck },
  { value: "ask", label: "标准", description: "写入与命令类工具执行前确认", Icon: ShieldAlert },
  { value: "plan", label: "计划", description: "只读分析，先输出计划再执行", Icon: BookOpen },
];

/**
 * 显示用文案。菜单只给 auto / medium / high 三档（见 thinking-levels.ts）；
 * 其余键是历史会话的回显兜底（老 session 里可能持久化 off/low/xhigh/max），
 * 删掉会让这些状态在状态栏里显示成原始英文枚举值。
 */
const THINKING_LABELS: Record<ThinkingLevel, string> = {
  auto: "自动",
  off: "关闭",
  minimal: "极简",
  low: "低",
  medium: "均衡",
  high: "高质量",
  xhigh: "极高",
  max: "最高",
};

/**
 * 锚定在按钮上方的菜单（fixed + portal）。
 *
 * 状态栏那一行是 `overflow-x-auto` 的滚动容器，绝对定位的下拉会被裁掉，
 * 所以菜单必须渲染到 body 上：定位用视口坐标，尺寸用 `bottom` 锚定
 * （菜单高度未知也不影响），左右夹在视口内。
 */
function useAnchoredMenu(open: boolean, anchorRef: React.RefObject<HTMLElement | null>) {
  const [position, setPosition] = useState<{ left: number; bottom: number } | null>(null);
  useEffect(() => {
    if (!open) return;
    const update = () => {
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const MENU_WIDTH = 168;
      const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - MENU_WIDTH - 8));
      setPosition({ left, bottom: Math.max(8, window.innerHeight - rect.top + 6) });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, anchorRef]);
  return position;
}

/** 工具名去重压缩：bash, edit, read +2。 */

interface Props {
  isStreaming: boolean;
  model: { provider: string; modelId: string } | null;
  modelNames?: Record<string, string>;
  modelList?: { id: string; name: string; provider: string; input?: string[] }[];
  onModelChange: (provider: string, modelId: string) => void;
  thinkingLevel: ThinkingLevel;
  availableThinkingLevels: readonly string[] | null;
  onThinkingLevelChange: (level: ThinkingLevel) => void;
  agentMode: AgentMode;
  onAgentModeChange: (mode: AgentMode) => void;
  soundEnabled: boolean;
  onSoundToggle: () => void;
  onCompactRequest: () => void;
  onGitDiff?: () => void;
  canCompact: boolean;
  compacting: boolean;
  sessionStats: SessionStats | null;
  contextUsage: ContextUsage | null;
  /** 回合数 + 工具调用汇总（可选：缺数据时不影响渲染）。 */
  activity?: SessionActivity | null;
  /** 当前会话所属项目目录：在工具栏最左侧显示极简项目标识。 */
  projectPath?: string | null;
  currentProvider?: string | null;
  /** 正在执行的工具（来自 agentPhase）；有值时显示心跳条 + `running: bash`。 */
  runningTools?: Array<{ id: string; name: string }> | null;
}

/** One-click plan-mode switch; remembers the mode to restore on toggle-off. */
function PlanToggle({
  mode,
  disabled,
  compact = false,
  onChange,
}: {
  mode: AgentMode;
  disabled: boolean;
  compact?: boolean;
  onChange: (mode: AgentMode) => void;
}) {
  const active = mode === "plan";
  const previousMode = useRef<AgentMode>("full");
  useEffect(() => {
    if (mode !== "plan") previousMode.current = mode;
  }, [mode]);

  return (
    <button
      type="button"
      onClick={() => onChange(active ? previousMode.current : "plan")}
      disabled={disabled}
      aria-pressed={active}
      title={
        active
          ? "计划模式：只读分析并先输出计划（点击关闭）"
          : "计划模式：先输出修改计划，批准后再执行"
      }
      className={`flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 text-[11px] transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${
        active
          ? "bg-[#E8EFFB] font-medium text-accent-strong ring-1 ring-[#C9DCFB] hover:bg-[#DDE9FC]"
          : "text-ink-muted hover:bg-[#ECECEF] hover:text-ink"
      }`}
    >
      <ListTodo size={13} strokeWidth={1.85} aria-hidden="true" className="shrink-0" />
      {/* 窄宽度只留图标，避免文字被压扁重叠 */}
      {!compact && <span className="whitespace-nowrap">Plan 模式</span>}
    </button>
  );
}

function ThinkingMenu({
  level,
  available,
  disabled,
  compact = false,
  onChange,
}: {
  level: ThinkingLevel;
  available: readonly string[] | null;
  disabled: boolean;
  compact?: boolean;
  onChange: (level: ThinkingLevel) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismissOnOutsideClick([ref, menuRef], open, () => setOpen(false));
  const position = useAnchoredMenu(open, buttonRef);

  const levels = getThinkingLevelsForModel(available) as ThinkingLevel[];

  return (
    <div ref={ref} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`思考强度：${THINKING_LABELS[level] ?? level}`}
        className="flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 text-[11px] text-ink-muted transition-colors duration-150 hover:bg-[#ECECEF] hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Gauge size={13} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
        {!compact && <span className="whitespace-nowrap">{THINKING_LABELS[level] ?? level}</span>}
        <ChevronDown
          size={11}
          strokeWidth={2}
          aria-hidden="true"
          className={`shrink-0 ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open &&
        position &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            className="material-popover t-dropdown is-open min-w-[132px] rounded-lg p-1"
            data-origin="bottom-left"
            style={{ position: "fixed", left: position.left, bottom: position.bottom, zIndex: 900 }}
          >
            {levels.map((item) => (
              <button
                key={item}
                type="button"
                role="menuitemradio"
                aria-checked={item === level}
                onClick={() => {
                  setOpen(false);
                  if (item !== level) onChange(item);
                }}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors duration-150 ${
                  item === level
                    ? "bg-[#E8EFFB] font-medium text-ink"
                    : "text-ink-muted hover:bg-[#ECECEF] hover:text-ink"
                }`}
              >
                <span className="flex w-3 shrink-0 justify-center">
                  {item === level && <Check size={11} strokeWidth={2.4} className="text-accent" />}
                </span>
                {THINKING_LABELS[item]}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}

function ModeMenu({
  mode,
  disabled,
  compact = false,
  onChange,
}: {
  mode: AgentMode;
  disabled: boolean;
  compact?: boolean;
  onChange: (mode: AgentMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismissOnOutsideClick([ref, menuRef], open, () => setOpen(false));
  const position = useAnchoredMenu(open, buttonRef);
  const current = AGENT_MODE_OPTIONS.find((option) => option.value === mode) ?? AGENT_MODE_OPTIONS[0];
  const CurrentIcon = current.Icon;

  return (
    <div ref={ref} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Agent 模式：${current.label}`}
        className="flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 text-[11px] text-ink-muted transition-colors duration-150 hover:bg-[#ECECEF] hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
      >
        <CurrentIcon size={13} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
        {!compact && <span className="whitespace-nowrap">{current.label}</span>}
        <ChevronDown
          size={11}
          strokeWidth={2}
          aria-hidden="true"
          className={`shrink-0 ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open &&
        position &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            className="material-popover t-dropdown is-open w-[210px] rounded-lg p-1"
            data-origin="bottom-left"
            style={{ position: "fixed", left: position.left, bottom: position.bottom, zIndex: 900 }}
          >
            {AGENT_MODE_OPTIONS.map(({ value, label, description, Icon }) => (
              <button
                key={value}
                type="button"
                role="menuitemradio"
                aria-checked={value === mode}
                onClick={() => {
                  setOpen(false);
                  if (value !== mode) onChange(value);
                }}
                className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-150 ${
                  value === mode
                    ? "bg-[#E8EFFB] text-ink"
                    : "text-ink-muted hover:bg-[#ECECEF] hover:text-ink"
                }`}
              >
                <span className="mt-0.5 flex w-3 shrink-0 justify-center">
                  {value === mode ? (
                    <Check size={11} strokeWidth={2.4} className="text-accent" />
                  ) : (
                    <Icon size={11} strokeWidth={1.8} aria-hidden="true" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[12px] font-medium">{label}</span>
                  <span className="mt-0.5 block text-[10.5px] leading-4 text-ink-faint">
                    {description}
                  </span>
                </span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}

export function StatusBar({
  isStreaming,
  model,
  modelNames,
  modelList,
  onModelChange,
  thinkingLevel,
  availableThinkingLevels,
  onThinkingLevelChange,
  agentMode,
  onAgentModeChange,
  soundEnabled,
  onSoundToggle,
  onCompactRequest,
  onGitDiff,
  canCompact,
  compacting,
  sessionStats,
  contextUsage,
  activity = null,
  projectPath = null,
  currentProvider,
}: Props) {
  // 底部工具栏按聊天面板自身宽度（而非视口宽度）响应：窄于 640px 时收起按钮文字，
  // 只留图标，给 Token / 费用 / 回合留出单行空间。用 ResizeObserver 而不是 CSS
  // container query——container-type 会变成 fixed 子孙的包含块，让模型下拉框 /
  // 用量弹窗错位。
  const projectName = projectPath ? projectNameFromCwd(projectPath) : "";

  const barRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const el = barRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? el.clientWidth;
      setCompact(width > 0 && width < 640);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={barRef} className="w-full">
      {/* 强制单行：绝不换行。宽度不够时整行横向滚动（滚动条隐藏），
          并且下方 compact 模式会先收起按钮文字，尽量不触发滚动。 */}
      <div className="scrollbar-none flex min-h-8 w-full flex-nowrap items-center gap-x-2 overflow-x-auto overflow-y-hidden whitespace-nowrap px-0.5 py-1">
        {/* 左侧操作区：shrink-0 + nowrap，永不被压扁 */}
        <div className="flex min-w-0 shrink-0 flex-nowrap items-center gap-0.5 whitespace-nowrap">
          {/* 项目标识：当前对话所属仓库，悬浮显示完整路径 */}
          {projectName && (
            <span
              className={`flex shrink-0 items-center gap-1 rounded-md py-0.5 text-[10px] text-ink-faint ${compact ? "px-0.5" : "mr-1 px-1"}`}
              title={projectPath ?? undefined}
              aria-label={`当前项目：${projectName}`}
            >
              <Folder size={10} strokeWidth={1.9} aria-hidden="true" className="shrink-0" />
              <span className={`truncate ${compact ? "max-w-[72px]" : "max-w-[140px]"}`}>
                {projectName}
              </span>
            </span>
          )}
          <ModelSelector
            isStreaming={isStreaming}
            model={model}
            modelNames={modelNames}
            modelList={modelList}
            compact={compact}
            onModelChange={onModelChange}
          />
          <ModeMenu
            mode={agentMode}
            disabled={isStreaming}
            compact={compact}
            onChange={onAgentModeChange}
          />
          <PlanToggle
            mode={agentMode}
            disabled={isStreaming}
            compact={compact}
            onChange={onAgentModeChange}
          />
          <ThinkingMenu
            level={thinkingLevel}
            available={availableThinkingLevels}
            disabled={isStreaming}
            compact={compact}
            onChange={onThinkingLevelChange}
          />
          <button
            type="button"
            onClick={onCompactRequest}
            disabled={!canCompact || compacting}
            aria-label="压缩上下文"
            title={compacting ? "正在压缩上下文…" : "压缩上下文（摘要旧对话，保留最近内容）"}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors duration-150 hover:bg-[#ECECEF] hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
          >
            {compacting ? (
              <Loader2 size={14} strokeWidth={1.75} className="animate-spin" aria-hidden="true" />
            ) : (
              <FileArchive size={14} strokeWidth={1.75} aria-hidden="true" />
            )}
          </button>
          {onGitDiff && (
            <button
              type="button"
              onClick={onGitDiff}
              aria-label="查看 Git Diff"
              title="查看 Git Diff"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors duration-150 hover:bg-[#ECECEF] hover:text-ink"
            >
              <GitCompare size={14} strokeWidth={1.75} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            onClick={onSoundToggle}
            aria-label={soundEnabled ? "关闭提示音" : "开启提示音"}
            aria-pressed={!soundEnabled}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors duration-150 hover:bg-[#ECECEF] hover:text-ink"
          >
            {soundEnabled ? (
              <Volume2 size={14} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <VolumeX size={14} strokeWidth={1.75} aria-hidden="true" />
            )}
          </button>
        </div>

        {/* Token / 费用 / 回合 / 工具统计：整块可点击打开“用量与额度”。
            统计区允许被子压缩（min-w-0 + flex-1）：宽度不够时优先裁掉
            工具调用详情，核心的 Token / 费用 / 回合保持 shrink-0 不裁不换行。 */}
        {/* min-w-[112px]：即便面板极窄也留住「费用 + 回合」，超出的部分让整行横向滚动，
            而不是把统计压成 0 宽（StatsBar 内部再按自身宽度逐级披露） */}
        <div className="ml-auto flex min-w-[112px] flex-1 flex-nowrap items-stretch justify-end whitespace-nowrap">
          <StatsBar
            showChat
            sessionStats={sessionStats}
            contextUsage={contextUsage}
            activity={activity}
            compact={compact}
            currentProvider={currentProvider}
          />
        </div>
      </div>
    </div>
  );
}

export default StatusBar;
