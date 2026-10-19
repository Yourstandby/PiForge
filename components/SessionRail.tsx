"use client";

import { useMemo } from "react";
import type { SessionInfo } from "@/lib/types";

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
}

export function SessionRail({ sessions, loading, selectedId, onSelect, onNewSession }: Props) {
  const items = useMemo(() => sessions, [sessions]);

  return (
    <aside className="flex w-[260px] shrink-0 flex-col border-r border-gray-200/60 bg-[#F5F5F7]">
      <div className="shrink-0 p-3">
        <button
          type="button"
          onClick={onNewSession}
          className="flex h-9 w-full items-center justify-center gap-1.5 rounded-lg border border-gray-200 bg-white text-[13px] font-medium text-neutral-700 shadow-[0_1px_2px_rgba(17,17,17,0.03)] transition-colors duration-150 hover:bg-neutral-100"
        >
          <span aria-hidden="true" className="text-[15px] leading-none text-neutral-400">
            +
          </span>
          新建会话
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <div className="px-1.5 pb-1.5 pt-1 text-[11px] font-medium uppercase tracking-wider text-neutral-400">
          历史会话
        </div>

        {loading && (
          <p className="px-1.5 py-2 text-[12px] text-neutral-400">加载中…</p>
        )}

        {!loading && items.length === 0 && (
          <p className="px-1.5 py-2 text-[12px] text-neutral-400">还没有会话</p>
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
                    ? "flex w-full flex-col gap-0.5 rounded-lg border border-gray-200 bg-white px-2.5 py-2 text-left shadow-[0_1px_2px_rgba(17,17,17,0.04)]"
                    : "flex w-full flex-col gap-0.5 rounded-lg border border-transparent px-2.5 py-2 text-left transition-colors duration-150 hover:bg-neutral-200/50"
                }
              >
                <span className="flex w-full items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] text-neutral-800">
                    {sessionTitle(session)}
                  </span>
                  <span className="shrink-0 text-[10px] tabular-nums text-neutral-400">
                    {formatTime(session.modified)}
                  </span>
                </span>
                <span className="w-full truncate text-[11px] text-neutral-400">
                  {projectName(session.cwd)}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </aside>
  );
}

export default SessionRail;
