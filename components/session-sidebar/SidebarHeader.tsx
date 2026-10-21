"use client";

import { useRef, useState } from "react";
import { PanelLeftClose, Plus } from "lucide-react";
import { NewProjectModal } from "./NewProjectModal";
import { SidebarIcon } from "./SidebarIcon";
import { ProjectSortMenu } from "./ProjectSortMenu";
import type { ProjectSortMode } from "./projects";
import { useI18n } from "../I18nProvider";

interface SidebarHeaderProps {
  selectedCwd: string | null;
  onNewSession: (cwd: string) => void;
  onAddProject: (cwd: string) => void;
  /** Shift+点击「+」：在独立窗口里打开项目（Electron 多窗口）。 */
  onOpenProjectWindow?: () => void;
  loadSessions: () => Promise<void>;
  sessionRefreshDone: boolean;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  sortMode: ProjectSortMode;
  onSortModeChange: (mode: ProjectSortMode, animate: boolean) => void;
  onCollapse?: () => void;
}

export function SidebarHeader({ selectedCwd, onNewSession, onAddProject, onOpenProjectWindow, loadSessions, sessionRefreshDone, searchQuery, onSearchQueryChange, sortMode, onSortModeChange, onCollapse }: SidebarHeaderProps) {
  const { t } = useI18n();
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  return (
    <header className="sidebar-header">
      <div className="sidebar-title-row">
        <div className="flex min-w-0 flex-1">
          <button
            className="sidebar-new-session-button"
            onClick={() => selectedCwd && onNewSession(selectedCwd)}
            disabled={!selectedCwd}
            title={selectedCwd ? t("sidebar.newSessionIn", { path: selectedCwd }) : t("sidebar.selectProjectFirst")}
          >
            <SidebarIcon name="plus" size={14} />
            {t("sidebar.newSession")}
          </button>
        </div>
        <button
          type="button"
          onClick={onCollapse}
          aria-label="折叠左侧边栏"
          title="折叠左侧边栏（Ctrl+B）"
          className="flex h-8 w-8 shrink-0 items-center justify-center text-gray-500 transition-colors duration-150 hover:text-gray-800"
        >
          <PanelLeftClose size={16} strokeWidth={1.75} className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      <div className="sidebar-search">
        <SidebarIcon name="search" size={14} />
        <input ref={searchRef} type="search" value={searchQuery} onChange={(event) => onSearchQueryChange(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Escape" && searchQuery) {
            event.stopPropagation();
            onSearchQueryChange("");
          }
        }} placeholder={t("sidebar.searchPlaceholder")} aria-label={t("sidebar.searchPlaceholder")} />
        {searchQuery && <button className="sidebar-icon-button" aria-label={t("sidebar.clearSearch")} onClick={() => { onSearchQueryChange(""); searchRef.current?.focus(); }}><SidebarIcon name="close" size={12} /></button>}
      </div>
      {/* 「项目」标题行：左边标题，右边常显的工具按钮（+ 永远可见，不受 hover 影响） */}
      <div className="sidebar-section-heading flex items-center justify-between w-full">
        <span>{t("sidebar.projects")}</span>
        <div className="flex items-center gap-1">
          <ProjectSortMenu value={sortMode} onChange={onSortModeChange} />
          <button
            type="button"
            onClick={() => void loadSessions()}
            title={t("sidebar.refreshSessions")}
            aria-label={t("sidebar.refreshSessions")}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-gray-500 hover:bg-gray-200 hover:text-gray-700 cursor-pointer"
          >
            <SidebarIcon name={sessionRefreshDone ? "check" : "refresh"} size={13} />
          </button>
          {/* 新建项目：带文字的按钮，点击先弹面板（选择现有 / 创建新文件夹） */}
          <button
            type="button"
            onClick={(event) => {
              if (event.shiftKey && onOpenProjectWindow) {
                onOpenProjectWindow();
                return;
              }
              setNewProjectOpen(true);
            }}
            title={onOpenProjectWindow ? `${t("sidebar.addProject")}（Shift+点击：在新窗口打开）` : t("sidebar.addProject")}
            aria-haspopup="dialog"
            className="flex h-5 shrink-0 items-center justify-center gap-0.5 rounded px-1.5 text-[11px] font-medium text-gray-500 transition-colors hover:bg-gray-200 hover:text-gray-700 cursor-pointer z-50"
          >
            <Plus size={12} strokeWidth={2} aria-hidden="true" />
            新建项目
          </button>
        </div>
      </div>
      <NewProjectModal
        open={newProjectOpen}
        onClose={() => setNewProjectOpen(false)}
        onAddProject={onAddProject}
      />
    </header>
  );
}
