"use client";

import { useMemo, useRef, useState } from "react";
import { Plug, Plus, Settings, Sparkles } from "lucide-react";
import type { SessionInfo } from "@/lib/types";
import { useDismissOnOutsideClick } from "@/hooks/useDismissOnOutsideClick";

function projectName(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

function sessionTitle(session: SessionInfo): string {
  const name = session.name?.trim();
  if (name) return name;
  const first = session.firstMessage?.split("\n")[0]?.trim();
  if (first) return first;
  return session.id.slice(0, 8);
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

interface Props {
  sessions: SessionInfo[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (session: SessionInfo) => void;
  onNewSession: () => void;
  onOpenSkills: () => void;
  onOpenMcp: () => void;
}

export function SessionRail({
  sessions,
  loading,
  selectedId,
  onSelect,
  onNewSession,
  onOpenSkills,
  onOpenMcp,
}: Props) {
  const items = useMemo(() => sessions, [sessions]);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismissOnOutsideClick(menuRef, menuOpen, () => setMenuOpen(false));

  return (
    <aside className="flex w-[260px] shrink-0 flex-col border-r border-gray-200/60 bg-[#F5F5F7]">
      <div className="shrink-0 p-3">
        <button
          type="button"
          onClick={onNewSession}
          className="group flex h-9 w-full items-center justify-center gap-1.5 rounded-lg border border-[#E4E4E0] bg-white text-[13px] font-medium text-ink-soft shadow-[0_1px_2px_rgba(17,17,17,0.03)] transition-colors duration-150 hover:border-[#CFDDFA] hover:bg-white"
        >
          <Plus
            size={14}
            strokeWidth={2}
            aria-hidden="true"
            className="text-accent transition-colors duration-150 group-hover:text-accent-strong"
          />
          新建会话
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <div className="px-1.5 pb-1.5 pt-1 text-[11px] font-medium uppercase tracking-wider text-ink-faint">
          历史会话
        </div>

        {loading && <p className="px-1.5 py-2 text-[12px] text-ink-faint">加载中…</p>}

        {!loading && items.length === 0 && (
          <p className="px-1.5 py-2 text-[12px] text-ink-faint">还没有会话</p>
        )}

        <div className="flex flex-col gap-0.5">
          {items.map((session) => {
            const active = session.id === selectedId;
            return (
              <button
                key={session.id}
                type="button"
                onClick={() => onSelect(session)}
                title={sessionTitle(session)}
                aria-current={active ? "true" : undefined}
                className={
                  active
                    ? "flex w-full flex-col gap-0.5 rounded-lg border border-[#D9E5FB] bg-white px-2.5 py-2 text-left shadow-[0_1px_2px_rgba(17,17,17,0.04)]"
                    : "flex w-full flex-col gap-0.5 rounded-lg border border-transparent px-2.5 py-2 text-left transition-colors duration-150 hover:bg-[#ECECEF]"
                }
              >
                <span className="flex w-full items-baseline gap-2">
                  <span
                    className={
                      active
                        ? "min-w-0 flex-1 truncate text-[13px] font-medium text-accent-strong"
                        : "min-w-0 flex-1 truncate text-[13px] text-ink"
                    }
                  >
                    {sessionTitle(session)}
                  </span>
                  <span className="shrink-0 text-[10px] tabular-nums text-ink-faint">
                    {formatTime(session.modified)}
                  </span>
                </span>
                <span className="w-full truncate text-[11px] text-ink-faint">
                  {projectName(session.cwd)}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div ref={menuRef} className="relative shrink-0 border-t border-gray-200/60 p-2">
        {menuOpen && (
          <div className="material-popover absolute bottom-full left-2 z-[60] mb-1 w-[212px] rounded-xl p-1.5">
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                onOpenSkills();
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-ink-muted transition-colors duration-150 hover:bg-[#ECECEF] hover:text-ink"
            >
              <Sparkles size={14} strokeWidth={1.75} className="text-accent" aria-hidden="true" />
              技能 · Skills
            </button>
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                onOpenMcp();
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-ink-muted transition-colors duration-150 hover:bg-[#ECECEF] hover:text-ink"
            >
              <Plug size={14} strokeWidth={1.75} className="text-accent" aria-hidden="true" />
              MCP 服务
            </button>
          </div>
        )}
        <button
          type="button"
          onClick={() => setMenuOpen((value) => !value)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] text-ink-muted transition-colors duration-150 hover:bg-[#ECECEF] hover:text-ink"
        >
          <Settings size={14} strokeWidth={1.75} aria-hidden="true" />
          设置
        </button>
      </div>
    </aside>
  );
}

export default SessionRail;
