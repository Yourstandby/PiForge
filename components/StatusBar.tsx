"use client";

import { useRef, useState } from "react";
import { Check, ChevronDown, Gauge, Volume2, VolumeX } from "lucide-react";
import { ModelSelector } from "./chat-input/ModelSelector";
import { getThinkingLevelsForModel } from "./chat-input/thinking-levels";
import { StatsBar, type ContextUsage, type SessionStats } from "./StatsBar";
import { useDismissOnOutsideClick } from "@/hooks/useDismissOnOutsideClick";

export type ThinkingLevel =
  | "auto"
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

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
  soundEnabled: boolean;
  onSoundToggle: () => void;
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

export function StatusBar({
  isStreaming,
  model,
  modelNames,
  modelList,
  onModelChange,
  thinkingLevel,
  availableThinkingLevels,
  onThinkingLevelChange,
  soundEnabled,
  onSoundToggle,
  sessionStats,
  contextUsage,
  currentProvider,
}: Props) {
  return (
    <div className="mt-2 flex items-center justify-between gap-3 px-0.5">
      <div className="flex min-w-0 items-center gap-0.5">
        <ModelSelector
          isStreaming={isStreaming}
          model={model}
          modelNames={modelNames}
          modelList={modelList}
          onModelChange={onModelChange}
        />
        <ThinkingMenu
          level={thinkingLevel}
          available={availableThinkingLevels}
          disabled={isStreaming}
          onChange={onThinkingLevelChange}
        />
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
