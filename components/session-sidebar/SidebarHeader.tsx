"use client";

import { useState, useCallback, useRef } from "react";
import { PanelLeftClose } from "lucide-react";
import { pickDirectoryFromHost } from "./helpers";
import { SidebarIcon } from "./SidebarIcon";
import { ProjectSortMenu } from "./ProjectSortMenu";
import type { ProjectSortMode } from "./projects";
import { useI18n } from "../I18nProvider";
import { useDismissOnOutsideClick } from "@/hooks/useDismissOnOutsideClick";

interface SidebarHeaderProps {
  selectedCwd: string | null;
  onNewSession: (cwd: string) => void;
  onAddProject: (cwd: string) => void;
  loadSessions: () => Promise<void>;
  sessionRefreshDone: boolean;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  sortMode: ProjectSortMode;
  onSortModeChange: (mode: ProjectSortMode, animate: boolean) => void;
  onCollapse?: () => void;
}

export function SidebarHeader({ selectedCwd, onNewSession, onAddProject, loadSessions, sessionRefreshDone, searchQuery, onSearchQueryChange, sortMode, onSortModeChange, onCollapse }: SidebarHeaderProps) {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const pickerButtonRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useDismissOnOutsideClick(pickerRef, menuOpen, (reason) => {
    setMenuOpen(false);
    if (reason === "escape") pickerButtonRef.current?.focus();
  });

  const addDirectory = useCallback(async (useDefault: boolean) => {
    setMenuOpen(false);
    setPickerError(null);
    setPicking(true);
    try {
      let path: string | null;
      if (useDefault) {
        const response = await fetch("/api/default-cwd", { method: "POST" });
        const data = await response.json() as { cwd?: string; error?: string };
        if (!response.ok || !data.cwd) throw new Error(data.error || t("common.failed"));
        path = data.cwd;
      } else {
        path = await pickDirectoryFromHost();
      }
      if (path?.trim()) {
        onSearchQueryChange("");
        onAddProject(path.trim());
      }
    } catch (error) {
      setPickerError(error instanceof Error ? error.message : t("common.failed"));
    } finally {
      setPicking(false);
      pickerButtonRef.current?.focus();
    }
  }, [onAddProject, onSearchQueryChange, t]);

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
          title="折叠左侧边栏"
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
      <div className="sidebar-section-heading">
        <span>{t("sidebar.projects")}</span>
        <div className="sidebar-section-actions">
          <ProjectSortMenu value={sortMode} onChange={onSortModeChange} />
          <button className="sidebar-icon-button sidebar-refresh-button" data-done={sessionRefreshDone || undefined} onClick={() => void loadSessions()} title={t("sidebar.refreshSessions")} aria-label={t("sidebar.refreshSessions")}>
            <SidebarIcon name={sessionRefreshDone ? "check" : "refresh"} size={14} />
          </button>
          <div ref={pickerRef} className="sidebar-project-picker">
            <button ref={pickerButtonRef} className="sidebar-icon-button" onClick={() => setMenuOpen((open) => !open)} disabled={picking} title={t("sidebar.addProject")} aria-label={t("sidebar.addProject")} aria-expanded={menuOpen}>
              <SidebarIcon name="folder-plus" size={16} />
            </button>
            {menuOpen && <div className="sidebar-picker-menu material-popover shadow-popover t-dropdown is-open" data-origin="top-right">
              <button onClick={() => void addDirectory(false)}><SidebarIcon name="folder" size={15} />{t("sidebar.chooseDirectory")}</button>
              <button onClick={() => void addDirectory(true)}><SidebarIcon name="plus" size={15} />{t("sidebar.defaultDirectory")}</button>
            </div>}
          </div>
        </div>
      </div>
      {picking && <p className="sidebar-notice" role="status">{t("sidebar.openingFolderPicker")}</p>}
      {pickerError && <p className="sidebar-notice text-danger" role="alert">{pickerError}</p>}
    </header>
  );
}
