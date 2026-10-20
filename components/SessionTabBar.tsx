"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";

/**
 * Browser-style tab strip for the middle chat column.
 *
 * Each open tab owns a mounted ChatSurface (state, stream and draft survive
 * switching), so this component stays presentational: it only reports which tab
 * was selected, closed, or that a new one is wanted.
 */
export interface SessionTabItem {
  key: string;
  title: string;
  /** Null for a not-yet-created session tab ("新会话"). */
  sessionId: string | null;
}

interface Props {
  tabs: SessionTabItem[];
  activeKey: string | null;
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
  onNew: () => void;
}

export function SessionTabBar({ tabs, activeKey, onSelect, onClose, onNew }: Props) {
  const [hovered, setHovered] = useState<string | null>(null);

  return (
    <div className="flex h-9 shrink-0 items-stretch gap-0.5 border-b border-[#E7E9EE] bg-[#F7F7F9] px-1.5 pt-1">
      <div role="tablist" aria-label="会话标签" className="flex min-w-0 flex-1 items-stretch gap-0.5 overflow-x-auto">
        {tabs.map((tab) => {
          const active = tab.key === activeKey;
          return (
            <div
              key={tab.key}
              role="tab"
              aria-selected={active}
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
              title={tab.title}
              className={`group flex h-8 max-w-[200px] min-w-[104px] shrink-0 cursor-pointer items-center gap-1.5 rounded-t-md pl-2.5 pr-1 text-[12.5px] transition-colors duration-150 ${
                active
                  ? "border border-b-0 border-[#E1E6F0] bg-white font-medium text-[#1F2937] shadow-[inset_0_2px_0_#2563EB]"
                  : "text-[#6B7280] hover:bg-[#EFEFF2] hover:text-[#374151]"
              }`}
            >
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

      <button
        type="button"
        onClick={onNew}
        title="新建会话标签"
        aria-label="新建会话标签"
        className="mb-0.5 ml-0.5 flex h-7 w-7 shrink-0 items-center justify-center self-center rounded-md text-[#6B7280] transition-colors hover:bg-[#E8EFFB] hover:text-[#2563EB]"
      >
        <Plus size={14} strokeWidth={2} aria-hidden="true" />
      </button>
    </div>
  );
}

export default SessionTabBar;
