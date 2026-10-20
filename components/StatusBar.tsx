"use client";

import { useRef, useState } from "react";
import {
  BookOpen,
  Check,
  ChevronDown,
  FileArchive,
  Gauge,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  Volume2,
  VolumeX,
} from "lucide-react";
import { ModelSelector } from "./chat-input/ModelSelector";
import { getThinkingLevelsForModel } from "./chat-input/thinking-levels";
import { StatsBar, type ContextUsage, type SessionStats } from "./StatsBar";
import { useDismissOnOutsideClick } from "@/hooks/useDismissOnOutsideClick";
import type { AgentMode } from "@/lib/approval-policy";

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
  { value: "plan", label: "只读", description: "仅允许读取与规划工具", Icon: BookOpen },
];

const THINKING_LABELS: Record<ThinkingLevel, string> = {
  auto: "自动",
  off: "关闭",
  minimal: "极简",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
};

interface Props {
  isStreaming: boolean;
  model: { provider: string; modelId: string } | null;
  modelNames?: Record<string, string>;
  modelList?: { id: string; name: string; provider: string }[];
  onModelChange: (provider: string, modelId: string) => void;
  thinkingLevel: ThinkingLevel;
  availableThinkingLevels: readonly string[] | null;
  onThinkingLevelChange: (level: ThinkingLevel) => void;
  agentMode: AgentMode;
  onAgentModeChange: (mode: AgentMode) => void;
  soundEnabled: boolean;
  onSoundToggle: () => void;
  onCompactRequest: () => void;
  canCompact: boolean;
  compacting: boolean;
  sessionStats: SessionStats | null;
  contextUsage: ContextUsage | null;
  currentProvider?: string | null;
}

function ThinkingMenu({
  level,
  available,
  disabled,
  onChange,
}: {
  level: ThinkingLevel;
  available: readonly string[] | null;
  disabled: boolean;
  onChange: (level: ThinkingLevel) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismissOnOutsideClick(ref, open, () => setOpen(false));

  const levels = getThinkingLevelsForModel(available) as ThinkingLevel[];

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`思考强度：${THINKING_LABELS[level] ?? level}`}
        className="flex h-7 items-center gap-1 rounded-md px-1.5 text-[11px] text-ink-muted transition-colors duration-150 hover:bg-[#ECECEF] hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Gauge size={13} strokeWidth={1.75} aria-hidden="true" />
        {THINKING_LABELS[level] ?? level}
        <ChevronDown size={11} strokeWidth={2} aria-hidden="true" className={open ? "rotate-180" : ""} />
      </button>

      {open && (
        <div
          role="menu"
          className="material-popover absolute bottom-full left-0 z-[600] mb-1.5 min-w-[132px] rounded-lg p-1"
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
        </div>
      )}
    </div>
  );
}

function ModeMenu({
  mode,
  disabled,
  onChange,
}: {
  mode: AgentMode;
  disabled: boolean;
  onChange: (mode: AgentMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismissOnOutsideClick(ref, open, () => setOpen(false));
  const current = AGENT_MODE_OPTIONS.find((option) => option.value === mode) ?? AGENT_MODE_OPTIONS[0];
  const CurrentIcon = current.Icon;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Agent 模式：${current.label}`}
        className="flex h-7 items-center gap-1 rounded-md px-1.5 text-[11px] text-ink-muted transition-colors duration-150 hover:bg-[#ECECEF] hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
      >
        <CurrentIcon size={13} strokeWidth={1.75} aria-hidden="true" />
        {current.label}
        <ChevronDown
          size={11}
          strokeWidth={2}
          aria-hidden="true"
          className={open ? "rotate-180" : ""}
        />
      </button>

      {open && (
        <div
          role="menu"
          className="material-popover absolute bottom-full left-0 z-[600] mb-1.5 w-[210px] rounded-lg p-1"
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
        </div>
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
  canCompact,
  compacting,
  sessionStats,
  contextUsage,
  currentProvider,
}: Props) {
  return (
    <div className="flex min-h-8 w-full items-center justify-between gap-3 px-0.5 py-1">
      <div className="flex min-w-0 items-center gap-0.5">
        <ModelSelector
          isStreaming={isStreaming}
          model={model}
          modelNames={modelNames}
          modelList={modelList}
          onModelChange={onModelChange}
        />
        <ModeMenu
          mode={agentMode}
          disabled={isStreaming}
          onChange={onAgentModeChange}
        />
        <ThinkingMenu
          level={thinkingLevel}
          available={availableThinkingLevels}
          disabled={isStreaming}
          onChange={onThinkingLevelChange}
        />
        <button
          type="button"
          onClick={onCompactRequest}
          disabled={!canCompact || compacting}
          aria-label="压缩上下文"
          title={compacting ? "正在压缩上下文…" : "压缩上下文（摘要旧对话，保留最近内容）"}
          className="flex h-7 w-7 items-center justify-center rounded-md text-ink-faint transition-colors duration-150 hover:bg-[#ECECEF] hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
        >
          {compacting ? (
            <Loader2 size={14} strokeWidth={1.75} className="animate-spin" aria-hidden="true" />
          ) : (
            <FileArchive size={14} strokeWidth={1.75} aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          onClick={onSoundToggle}
          aria-label={soundEnabled ? "关闭提示音" : "开启提示音"}
          aria-pressed={!soundEnabled}
          className="flex h-7 w-7 items-center justify-center rounded-md text-ink-faint transition-colors duration-150 hover:bg-[#ECECEF] hover:text-ink"
        >
          {soundEnabled ? (
            <Volume2 size={14} strokeWidth={1.75} aria-hidden="true" />
          ) : (
            <VolumeX size={14} strokeWidth={1.75} aria-hidden="true" />
          )}
        </button>
      </div>

      <StatsBar
        showChat
        sessionStats={sessionStats}
        contextUsage={contextUsage}
        currentProvider={currentProvider}
      />
    </div>
  );
}

export default StatusBar;
