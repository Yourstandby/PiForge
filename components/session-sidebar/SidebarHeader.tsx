"use client";

import { useState, useCallback, useRef } from "react";
import { BrandLogo } from "../BrandLogo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Search, FolderPlus, X } from "lucide-react";
import { pickDirectoryFromHost } from "./helpers";
import { SidebarIcon } from "./SidebarIcon";
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
}

export function SidebarHeader({ selectedCwd, onNewSession, onAddProject, searchQuery, onSearchQueryChange }: SidebarHeaderProps) {
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
        <span className="sidebar-brand" title="PiForge">
          <BrandLogo size={20} />
        </span>
        <Button
          size="sm"
          className="ml-auto h-7 rounded-lg px-2.5 text-[12px] font-medium"
          onClick={() => selectedCwd && onNewSession(selectedCwd)}
          disabled={!selectedCwd}
          title={selectedCwd ? t("sidebar.newSessionIn", { path: selectedCwd }) : t("sidebar.selectProjectFirst")}
        >
          <Plus />
          {t("sidebar.newSession")}
        </Button>
      </div>
      <div className="sidebar-search relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 z-10 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={searchRef}
          type="search"
          value={searchQuery}
          onChange={(event) => onSearchQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && searchQuery) {
              event.stopPropagation();
              onSearchQueryChange("");
            }
          }}
          placeholder={t("sidebar.searchPlaceholder")}
          aria-label={t("sidebar.searchPlaceholder")}
          className="h-8 rounded-lg border-border/70 bg-card/60 pl-8 pr-7 text-[13px] backdrop-blur"
        />
        {searchQuery && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("sidebar.clearSearch")}
            onClick={() => { onSearchQueryChange(""); searchRef.current?.focus(); }}
            className="absolute right-1 top-1/2 -translate-y-1/2"
          >
            <X />
          </Button>
        )}
      </div>
      <div className="sidebar-section-heading">
        <span>{t("sidebar.projects")}</span>
        <div className="sidebar-section-actions">
          <div ref={pickerRef} className="sidebar-project-picker">
            <Button
              ref={pickerButtonRef}
              variant="ghost"
              size="icon-sm"
              onClick={() => setMenuOpen((open) => !open)}
              disabled={picking}
              title={t("sidebar.addProject")}
              aria-label={t("sidebar.addProject")}
              aria-expanded={menuOpen}
            >
              <FolderPlus />
            </Button>
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
