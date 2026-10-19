"use client";

import { useState, useCallback, useRef, useEffect, useLayoutEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { SessionSidebar } from "./SessionSidebar";
import { ChatWindow } from "./ChatWindow";
import { FileViewer } from "./FileViewer";
import { TabBar } from "./TabBar";
import { Button } from "@/components/ui/button";
import { Settings } from "lucide-react";
import { ModelsConfig } from "./ModelsConfig";
import { SkillsConfig } from "./SkillsConfig";
import { BranchNavigator } from "./BranchNavigator";
import { ExtensionsConfigModal } from "./ExtensionsConfigModal";
import { SessionExportModal } from "./SessionExportModal";
import { BranchCloneModal, type BranchCloneMode } from "./BranchCloneModal";
import { useTheme } from "@/hooks/useTheme";
import type { SessionInfo, SessionTreeNode } from "@/lib/types";
import type { ChatInputHandle } from "./ChatInput";
import { usePanelLayout } from "@/hooks/usePanelLayout";
import { useDismissOnOutsideClick } from "@/hooks/useDismissOnOutsideClick";
import { useFileTabs } from "@/hooks/useFileTabs";
import { useI18n } from "./I18nProvider";

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return target.isContentEditable || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function getPathName(path: string | null): string {
  if (!path) return "Pi";
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "Pi";
}

const SHELL_MENU_GAP = 6;
const SHELL_MENU_EDGE_PADDING = 8;
const SHELL_MENU_RIGHT_OFFSET = 4;

const THEME_OPTIONS = [
  { id: "light", labelKey: "shell.lightAppearance", glyph: "☀" },
  { id: "dark", labelKey: "shell.darkAppearance", glyph: "◐" },
  { id: "glacier", labelKey: "shell.glacierAppearance", glyph: "❄" },
] as const;

type DesktopBridge = { openWindow?: (path: string) => unknown };

function getDesktopBridge(): DesktopBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { electronAPI?: DesktopBridge }).electronAPI;
}

export function AppShell() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { theme, setTheme, toggleTheme } = useTheme();
  const { locale, preference: localePreference, setPreference: setLocalePreference, t } = useI18n();
  const [selectedSession, setSelectedSession] = useState<SessionInfo | null>(null);
  // When user clicks +, we only store the cwd — no fake session id
  const [newSessionCwd, setNewSessionCwd] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [sessionKey, setSessionKey] = useState(0);
  const [explorerRefreshKey, setExplorerRefreshKey] = useState(0);
  const [modelsConfigOpen, setModelsConfigOpen] = useState(false);
  const [modelsRefreshKey, setModelsRefreshKey] = useState(0);
  const [skillsConfigOpen, setSkillsConfigOpen] = useState(false);
  const [sidebarMenuOpen, setSidebarMenuOpen] = useState(false);
  const sidebarMenuRef = useRef<HTMLDivElement>(null);
  const [extensionsModalOpen, setExtensionsModalOpen] = useState(false);
  const [shellMenuOpen, setShellMenuOpen] = useState(false);
  const shellMenuRef = useRef<HTMLDivElement>(null);
  const shellMenuButtonRef = useRef<HTMLButtonElement>(null);
  const [shellMenuPosition, setShellMenuPosition] = useState<{ top: number; right: number } | null>(null);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [exportSessionId, setExportSessionId] = useState<string | null>(null);
  const [branchCloneModal, setBranchCloneModal] = useState<{
    isOpen: boolean;
    mode: BranchCloneMode;
    sessionId: string | null;
    targetEntryId?: string;
  }>({ isOpen: false, mode: "branch", sessionId: null });
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const topBarRef = useRef<HTMLDivElement>(null);
  const {
    sidebarOpen,
    setSidebarOpen,
    rightPanelOpen,
    setRightPanelOpen,
    panelWidths,
    resizingSide,
    beginPanelResize,
  } = usePanelLayout();

  const {
    fileTabs,
    activeFileTabId,
    setActiveFileTabId,
    handleOpenFile,
    handleCloseFileTab,
  } = useFileTabs(
    () => setRightPanelOpen(true),
    () => setRightPanelOpen(false)
  );

  // Branch navigator state — populated by ChatWindow via onBranchDataChange
  const [branchTree, setBranchTree] = useState<SessionTreeNode[]>([]);
  const [branchActiveLeafId, setBranchActiveLeafId] = useState<string | null>(null);
  const branchLeafChangeFnRef = useRef<((leafId: string | null) => void) | null>(null);

  const handleBranchDataChange = useCallback(
    (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => {
      setBranchTree(tree);
      setBranchActiveLeafId(activeLeafId);
      branchLeafChangeFnRef.current = onLeafChange;
    },
    []
  );

  const handleBranchLeafChange = useCallback((leafId: string | null) => {
    branchLeafChangeFnRef.current?.(leafId);
  }, []);

  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);

  const handleSystemPromptChange = useCallback((prompt: string | null) => {
    setSystemPrompt(prompt);
  }, []);

  // Single active panel — only one dropdown open at a time
  const [activeTopPanel, setActiveTopPanel] = useState<"branches" | "system" | null>(null);
  const [topPanelPos, setTopPanelPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const toggleTopPanel = useCallback((panel: "branches" | "system") => {
    setActiveTopPanel((cur) => (cur === panel ? null : panel));
  }, []);

  useDismissOnOutsideClick(shellMenuRef, shellMenuOpen, (reason) => {
    setShellMenuOpen(false);
    if (reason === "escape") shellMenuButtonRef.current?.focus();
  });

  const updateShellMenuPosition = useCallback(() => {
    const button = shellMenuButtonRef.current;
    if (!button) return;

    const rect = button.getBoundingClientRect();
    setShellMenuPosition({
      top: rect.bottom + SHELL_MENU_GAP,
      right: Math.max(
        SHELL_MENU_EDGE_PADDING,
        window.innerWidth - rect.right + SHELL_MENU_RIGHT_OFFSET,
      ),
    });
  }, []);

  useLayoutEffect(() => {
    if (!shellMenuOpen) return;
    updateShellMenuPosition();
    window.addEventListener("resize", updateShellMenuPosition);
    return () => window.removeEventListener("resize", updateShellMenuPosition);
  }, [shellMenuOpen, updateShellMenuPosition]);

  useEffect(() => {
    if (!activeTopPanel || !topBarRef.current) return;
    const update = () => {
      const rect = topBarRef.current!.getBoundingClientRect();
      setTopPanelPos({ top: rect.bottom, left: rect.left, width: rect.width });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(topBarRef.current);
    return () => ro.disconnect();
  }, [activeTopPanel]);

  const [initialSessionId, setInitialSessionId] = useState<string | null>(null);
  const [initialSessionRestored, setInitialSessionRestored] = useState(false);
  const [activeCwd, setActiveCwd] = useState<string | null>(null);
  const [canOpenNewWindow, setCanOpenNewWindow] = useState(false);

  useEffect(() => {
    setCanOpenNewWindow(typeof getDesktopBridge()?.openWindow === "function");
  }, []);

  const openNewWindow = useCallback((cwd?: string | null) => {
    const bridge = getDesktopBridge();
    if (typeof bridge?.openWindow !== "function") return;
    const path = cwd ? `/?cwd=${encodeURIComponent(cwd)}` : "/";
    try {
      void Promise.resolve(bridge.openWindow(path)).catch(() => {});
    } catch {
      // Opening a window is best-effort; the current window stays usable.
    }
  }, []);

  useEffect(() => {
    const s = searchParams.get("session");
    if (s) {
      setInitialSessionId(s);
      return;
    }
    // `?cwd=...` opens a window bound to a project: start in a fresh session
    // for that working directory instead of restoring the last session.
    const cwd = searchParams.get("cwd");
    if (cwd) {
      setActiveCwd(cwd);
      setNewSessionCwd(cwd);
    }
    setInitialSessionRestored(true);
  }, [searchParams]);

  useEffect(() => {
    const projectName = activeCwd ? getPathName(activeCwd) : null;
    document.title = projectName && projectName !== "PiForge" ? `${projectName} — PiForge` : "PiForge";
  }, [activeCwd]);

  const handleCwdChange = useCallback((cwd: string | null) => {
    setActiveCwd(cwd);
    setExplorerRefreshKey((k) => k + 1);
  }, []);

  const handleSelectSession = useCallback(
    (session: SessionInfo, isRestore?: boolean) => {
      setSelectedSession(session);
      setNewSessionCwd(null);
      setSessionKey((k) => k + 1);
      setBranchTree([]);
      setBranchActiveLeafId(null);
      setSystemPrompt(null);
      setActiveTopPanel(null);

      if (session.cwd && session.cwd !== activeCwd) {
        setActiveCwd(session.cwd);
        setExplorerRefreshKey((k) => k + 1);
      }

      if (!isRestore) {
        router.replace(`/?session=${encodeURIComponent(session.id)}`, { scroll: false });
      }
      setInitialSessionRestored(true);
    },
    [router, activeCwd]
  );

  const handleNewSession = useCallback(
    (tempId: string, cwd: string) => {
      setSelectedSession(null);
      setNewSessionCwd(cwd);
      setSessionKey((k) => k + 1);
      setBranchTree([]);
      setBranchActiveLeafId(null);
      setSystemPrompt(null);
      setActiveTopPanel(null);

      if (cwd !== activeCwd) {
        setActiveCwd(cwd);
        setExplorerRefreshKey((k) => k + 1);
      }

      router.replace("/", { scroll: false });
    },
    [router, activeCwd]
  );

  const handleSessionCreated = useCallback((session: SessionInfo) => {
    setRefreshKey((k) => k + 1);
    router.replace(`/?session=${encodeURIComponent(session.id)}`, { scroll: false });
  }, [router]);


  const handleSessionForked = useCallback(
    (newId: string) => {
      setRefreshKey((k) => k + 1);
      void (async () => {
        try {
          const { resolveForkedSession } = await import("@/lib/fork-session-wait");
          const found = await resolveForkedSession(
            newId,
            async () => {
              const res = await fetch("/api/sessions");
              if (!res.ok) return [];
              const data = (await res.json()) as { sessions: SessionInfo[] };
              return data.sessions;
            },
            async (id) => {
              const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
              if (!res.ok) return null;
              const data = (await res.json()) as { info?: SessionInfo | null };
              return data.info ?? null;
            }
          );
          if (found) handleSelectSession(found, false);
        } catch {
          // ignore
        }
      })();
    },
    [handleSelectSession]
  );

  const handleAgentEnd = useCallback(() => {
    setRefreshKey((k) => k + 1);
    setExplorerRefreshKey((k) => k + 1);
  }, []);

  const handleAtMention = useCallback((relativePath: string) => {
    chatInputRef.current?.insertText(`@${relativePath}`);
  }, []);

  const handleInitialRestoreDone = useCallback(() => {
    setInitialSessionRestored(true);
  }, []);

  const handleSessionDeleted = useCallback(
    (sessionId: string) => {
      setRefreshKey((k) => k + 1);
      if (selectedSession?.id === sessionId) {
        const cwd = selectedSession.cwd;
        setSelectedSession(null);
        setNewSessionCwd(cwd ?? null);
        setSessionKey((k) => k + 1);
        setBranchTree([]);
        setBranchActiveLeafId(null);
        setSystemPrompt(null);
        setActiveTopPanel(null);
        router.replace("/", { scroll: false });
      }
    },
    [selectedSession, router]
  );


  // Keyboard shortcuts: Windows-oriented app commands.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.metaKey || isEditableTarget(e.target)) return;
      const key = e.key.toLowerCase();

      if (e.altKey && !e.shiftKey && key === "b") {
        e.preventDefault();
        setRightPanelOpen((v) => !v);
        return;
      }
      if (e.altKey) return;

      if (!e.shiftKey && key === "b") {
        e.preventDefault();
        setSidebarOpen((v) => !v);
        return;
      }
      if (e.shiftKey && key === "b") {
        e.preventDefault();
        setRightPanelOpen((v) => !v);
        return;
      }
      if (e.shiftKey && key === "m") {
        e.preventDefault();
        setModelsConfigOpen(true);
        return;
      }
      if (e.shiftKey && key === "s") {
        const cwd = activeCwd ?? selectedSession?.cwd ?? newSessionCwd;
        if (!cwd) return;
        e.preventDefault();
        setSkillsConfigOpen(true);
        return;
      }
      if (e.shiftKey && key === "t") {
        e.preventDefault();
        toggleTheme();
        return;
      }
      if (e.shiftKey && key === "n") {
        e.preventDefault();
        openNewWindow(activeCwd ?? selectedSession?.cwd ?? newSessionCwd);
        return;
      }
      if (e.shiftKey && key === "f") {
        e.preventDefault();
        setRightPanelOpen(true);
        return;
      }
      if (!e.shiftKey && key === "n") {
        const cwd = activeCwd ?? selectedSession?.cwd ?? newSessionCwd;
        if (!cwd) return;
        e.preventDefault();
        handleNewSession("", cwd);
      }
    };
    
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
    };
  }, [activeCwd, handleNewSession, newSessionCwd, openNewWindow, selectedSession?.cwd, toggleTheme, setRightPanelOpen, setSidebarOpen]);

  const effectiveNewSessionCwd = newSessionCwd ?? (selectedSession === null && activeCwd ? activeCwd : null);
  const showChat = selectedSession !== null || effectiveNewSessionCwd !== null;
  const showPlaceholder = initialSessionRestored && !showChat;
  const activeFileTab = fileTabs.find((t) => t.id === activeFileTabId) ?? null;

  const sidebarContent = (
    <>
      <SessionSidebar
        selectedSessionId={selectedSession?.id ?? null}
        onSelectSession={handleSelectSession}
        onNewSession={handleNewSession}
        initialSessionId={initialSessionId}
        onInitialRestoreDone={handleInitialRestoreDone}
        refreshKey={refreshKey}
        onSessionDeleted={handleSessionDeleted}
        onBranchSession={async (s) => {
          let targetEntryId = s.leafEntryId;
          if (!targetEntryId && s.id === selectedSession?.id) {
            targetEntryId = selectedSession.leafEntryId ?? branchActiveLeafId ?? undefined;
          }
          if (!targetEntryId) {
            try {
              const res = await fetch(`/api/sessions/${encodeURIComponent(s.id)}`);
              if (res.ok) {
                const data = (await res.json()) as { context?: { entryIds?: string[] } };
                if (data.context?.entryIds?.length) {
                  targetEntryId = data.context.entryIds[data.context.entryIds.length - 1];
                }
              }
            } catch {}
          }
          setBranchCloneModal({
            isOpen: true,
            mode: "branch",
            sessionId: s.id,
            targetEntryId,
          });
        }}
        onCloneSession={(s) => setBranchCloneModal({ isOpen: true, mode: "clone", sessionId: s.id })}
        onExportSession={(s) => { setExportSessionId(s.id); setExportModalOpen(true); }}
        selectedCwd={activeCwd ?? selectedSession?.cwd ?? newSessionCwd ?? null}
        onOpenInNewWindow={canOpenNewWindow ? openNewWindow : undefined}
        onCwdChange={handleCwdChange}
        onOpenFile={handleOpenFile}
        explorerRefreshKey={explorerRefreshKey}
        onAtMention={handleAtMention}
      />
      {/* One settings entry point. The old models/skills dock is gone; both live
          behind this gear so the sidebar keeps a single action. */}
      <div className="shrink-0 p-2" ref={sidebarMenuRef}>
        <Button
          type="button"
          variant="ghost"
          onClick={() => setSidebarMenuOpen((open) => !open)}
          aria-haspopup="menu"
          aria-expanded={sidebarMenuOpen}
          title={t("shell.settings")}
          aria-label={t("shell.settings")}
          className="h-9 w-full justify-center gap-2 rounded-xl border border-border/70 bg-card/50 text-[13px] font-normal text-muted-foreground backdrop-blur hover:text-foreground"
        >
          <Settings className="size-4" />
          {t("shell.settings")}
        </Button>
        {sidebarMenuOpen && (
          <div
            role="menu"
            className="t-dropdown is-open material-popover absolute bottom-[calc(100%-4px)] left-2 z-[650] w-48 rounded-panel border border-border p-1.5 shadow-popover"
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => { setSidebarMenuOpen(false); setModelsConfigOpen(true); }}
              className="flex w-full items-center gap-2 rounded-control border-none bg-transparent px-2.5 py-2 text-left text-[12px] text-text hover:bg-bg-hover"
            >
              <span className="w-4 text-center" aria-hidden="true">◇</span> {t("shell.models")}
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!activeCwd && !selectedSession?.cwd && !newSessionCwd}
              onClick={() => { setSidebarMenuOpen(false); setSkillsConfigOpen(true); }}
              className="flex w-full items-center gap-2 rounded-control border-none bg-transparent px-2.5 py-2 text-left text-[12px] text-text hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-35"
            >
              <span className="w-4 text-center" aria-hidden="true">▤</span> {t("shell.skills")}
            </button>
          </div>
        )}
      </div>
    </>
  );

  return (
    <>
      <div className="flex h-screen overflow-hidden bg-bg">
        {/* Mobile overlay backdrop */}
        <div
          className="sidebar-overlay-backdrop fixed inset-0 z-[199] bg-black/40 transition-opacity duration-250 ease-in-out"
          onClick={() => setSidebarOpen(false)}
          style={{
            opacity: sidebarOpen ? 1 : 0,
            pointerEvents: sidebarOpen ? "auto" : "none",
          }}
        />

        {/* Left sidebar */}
        <div
          className={`sidebar-container${sidebarOpen ? " sidebar-open" : " sidebar-closed"}${resizingSide === "left" ? " is-resizing" : ""} material-sidebar border-r border-divider flex flex-col shrink-0 z-[200]`}
          style={{
            width: sidebarOpen ? panelWidths.left : 0,
            minWidth: sidebarOpen ? panelWidths.left : 0,
          }}
        >
          {sidebarContent}
          {sidebarOpen && (
            <div
              className="panel-resize-handle panel-resize-handle-left"
              role="separator"
              aria-orientation="vertical"
              aria-label={t("shell.resizeSidebar")}
              onPointerDown={(e) => beginPanelResize("left", e)}
            />
          )}
        </div>

        {/* Center: chat */}
        <div className="relative flex-1 flex flex-col overflow-hidden min-w-0">
          {/* Top bar with sidebar toggle */}
          <div ref={topBarRef} className="material-toolbar flex items-center shrink-0 border-b border-divider h-toolbar-height [-webkit-app-region:drag]">
            <div
              aria-hidden="true"
              className={`macos-titlebar-leading-safe-area${sidebarOpen ? "" : " is-active"}`}
            />
            <button
              onClick={() => setSidebarOpen((v) => !v)}
              title={sidebarOpen ? t("shell.hideSidebar") : t("shell.showSidebar")}
              aria-label={sidebarOpen ? t("shell.hideSidebar") : t("shell.showSidebar")}
              className="group ml-2 flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] border-none bg-transparent p-0 text-text-dim cursor-pointer transition-[background-color,color,transform] duration-150 hover:bg-bg-hover hover:text-text active:scale-95 [-webkit-app-region:no-drag]"
            >
              {sidebarOpen ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <line x1="9" y1="3" x2="9" y2="21" />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="3" y1="6" x2="21" y2="6" />
                  <line x1="3" y1="12" x2="21" y2="12" />
                  <line x1="3" y1="18" x2="21" y2="18" />
                </svg>
              )}
            </button>
            <div className="hidden min-w-0 items-center gap-1.5 px-3 text-[11px] select-none md:flex">
              <span className="max-w-36 truncate font-medium text-text">{getPathName(activeCwd)}</span>
              {showChat && (
                <>
                  <span className="text-text-dim">/</span>
                  <span className="max-w-52 truncate text-text-muted">
                    {selectedSession?.name || selectedSession?.firstMessage || t("shell.newSessionName")}
                  </span>
                </>
              )}
            </div>
            {showChat && (
              <div className="flex items-stretch h-full [-webkit-app-region:no-drag]">
                <BranchNavigator
                  tree={branchTree}
                  activeLeafId={branchActiveLeafId}
                  onLeafChange={handleBranchLeafChange}
                  onBranch={() => {
                    if (selectedSession) {
                      setBranchCloneModal({
                        isOpen: true,
                        mode: "branch",
                        sessionId: selectedSession.id,
                        targetEntryId: branchActiveLeafId ?? undefined,
                      });
                    }
                  }}
                  onClone={() => {
                    if (selectedSession) {
                      setBranchCloneModal({
                        isOpen: true,
                        mode: "clone",
                        sessionId: selectedSession.id,
                      });
                    }
                  }}
                  inline
                  containerRef={topBarRef}
                  open={activeTopPanel === "branches"}
                  onToggle={() => toggleTopPanel("branches")}
                  hasSession={!!selectedSession}
                />

              </div>
            )}
            <div className="flex-1" />
            {/* One-click language switch: 中文 ⇄ English (system default stays
                available in the workbench menu). */}
            <button
              type="button"
              onClick={() => setLocalePreference(locale === "zh-CN" ? "en" : "zh-CN")}
              title={t("language.label")}
              aria-label={t("language.label")}
              className="flex h-full w-10 shrink-0 items-center justify-center border-none border-l border-divider bg-transparent text-[11px] font-medium text-text-muted transition-colors duration-150 hover:text-text [-webkit-app-region:no-drag]"
            >
              {locale === "zh-CN" ? "中" : "EN"}
            </button>
            <div ref={shellMenuRef} className="relative h-full [-webkit-app-region:no-drag]">
              <button
                ref={shellMenuButtonRef}
                type="button"
                onClick={() => setShellMenuOpen((open) => !open)}
                aria-label={t("shell.workbenchMenu")}
                aria-haspopup="menu"
                aria-controls="workbench-menu"
                aria-expanded={shellMenuOpen}
                className="flex h-full w-9 items-center justify-center border-none border-l border-divider bg-transparent text-text-muted transition-colors duration-150 hover:text-text"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" />
                </svg>
              </button>
              {shellMenuOpen && shellMenuPosition && (
                <div
                  id="workbench-menu"
                  role="menu"
                  className="t-dropdown is-open material-popover fixed z-[700] w-52 rounded-panel border border-border p-1.5 shadow-popover"
                  style={shellMenuPosition}
                  data-origin="top-right"
                >
                  <div className="px-2.5 pb-1 pt-1.5 text-[11px] text-text-dim">
                    {t("shell.appearance")}
                  </div>
                  {THEME_OPTIONS.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={theme === option.id}
                      onClick={(event) => {
                        const rect = event.currentTarget.getBoundingClientRect();
                        setShellMenuOpen(false);
                        setTheme(option.id, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
                      }}
                      className="flex w-full items-center gap-2 rounded-control border-none bg-transparent px-2.5 py-2 text-left text-[12px] text-text hover:bg-bg-hover"
                    >
                      <span className="w-4 text-center">{option.glyph}</span>
                      <span className="flex-1">{t(option.labelKey)}</span>
                      {theme === option.id && <span className="text-accent">✓</span>}
                    </button>
                  ))}
                  {canOpenNewWindow && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setShellMenuOpen(false);
                        openNewWindow(activeCwd ?? selectedSession?.cwd ?? newSessionCwd);
                      }}
                      className="flex w-full items-center gap-2 rounded-control border-none bg-transparent px-2.5 py-2 text-left text-[12px] text-text hover:bg-bg-hover"
                    >
                      <span className="w-4 text-center">⧉</span> {t("shell.newWindow")}
                    </button>
                  )}
                  {showChat && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => { setShellMenuOpen(false); toggleTopPanel("system"); }}
                      className="flex w-full items-center gap-2 rounded-control border-none bg-transparent px-2.5 py-2 text-left text-[12px] text-text hover:bg-bg-hover"
                    >
                      <span className={`w-4 text-center ${systemPrompt ? "text-accent" : "text-text-dim"}`}>⌘</span> {t("shell.systemPrompt")}
                    </button>
                  )}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => { setShellMenuOpen(false); setExtensionsModalOpen(true); }}
                    className="flex w-full items-center gap-2 rounded-control border-none bg-transparent px-2.5 py-2 text-left text-[12px] text-text hover:bg-bg-hover"
                  >
                    <span className="w-4 text-center">⌘</span> {t("shell.extensionsMcp")}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!selectedSession}
                    onClick={() => {
                      setShellMenuOpen(false);
                      setExportSessionId(selectedSession?.id ?? null);
                      setExportModalOpen(true);
                    }}
                    className="flex w-full items-center gap-2 rounded-control border-none bg-transparent px-2.5 py-2 text-left text-[12px] text-text hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    <span className="w-4 text-center">⇩</span> {t("shell.exportSession")}
                  </button>
                  <div className="my-1 border-t border-divider" />
                  <label className="flex w-full items-center gap-2 rounded-control px-2.5 py-1.5 text-[12px] text-text">
                    <span className="w-4 text-center" aria-hidden="true">文</span>
                    <span className="flex-1">{t("language.label")}</span>
                    <select
                      value={localePreference}
                      onChange={(event) => setLocalePreference(event.target.value as "system" | "en" | "zh-CN")}
                      aria-label={t("language.label")}
                      className="max-w-28 rounded-control border border-border bg-bg-panel px-1.5 py-1 text-[11px] text-text outline-none focus:border-focus-ring"
                    >
                      <option value="system">{t("language.system")}</option>
                      <option value="en">{t("language.english")}</option>
                      <option value="zh-CN">{t("language.chineseSimplified")}</option>
                    </select>
                  </label>
                </div>
              )}
            </div>
            {!rightPanelOpen && (
              <>
                <button
                  onClick={() => setRightPanelOpen(true)}
                  title={t("shell.showFilePanel")}
                  aria-label={t("shell.showFilePanel")}
                  className="flex items-center justify-center w-9 h-full p-0 bg-transparent border-none border-l border-divider text-text-muted hover:text-text cursor-pointer shrink-0 transition-colors duration-150 [-webkit-app-region:no-drag]"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <line x1="15" y1="3" x2="15" y2="21" />
                  </svg>
                </button>
                <div className="w-titlebar shrink-0" />
              </>
            )}
            {/* Top panel dropdown — shared, only one active at a time */}
            {activeTopPanel && topPanelPos && (
              <div
                className="fixed z-[500]"
                style={{
                  top: topPanelPos.top,
                  left: topPanelPos.left,
                  width: topPanelPos.width,
                }}
              >
                {activeTopPanel === "system" && (
                  <div className="t-dropdown is-open material-popover border-b border-divider shadow-popover" data-origin="top-center">
                    {systemPrompt ? (
                      <div className="max-h-[min(600px,75vh)] overflow-y-auto px-4 py-3 text-text-muted text-[12px] leading-[1.6] whitespace-pre-wrap font-mono">
                        {systemPrompt}
                      </div>
                    ) : systemPrompt === "" ? (
                      <div className="px-4 py-2.5 text-[12px] text-text-muted italic">
                        {t("shell.systemPromptEmpty")}
                      </div>
                    ) : (
                      <div className="px-4 py-2.5 text-[12px] text-text-muted italic">
                        {t("shell.systemPromptLoadHint")}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Chat content */}
          <div className="flex-1 overflow-hidden relative">
            {showChat ? (
              <ChatWindow
                key={sessionKey}
                session={selectedSession}
                newSessionCwd={effectiveNewSessionCwd}
                onAgentEnd={handleAgentEnd}
                onSessionCreated={handleSessionCreated}
                onSessionForked={handleSessionForked}
                modelsRefreshKey={modelsRefreshKey}
                chatInputRef={chatInputRef}
                onBranchDataChange={handleBranchDataChange}
                onSystemPromptChange={handleSystemPromptChange}
              />
            ) : showPlaceholder ? (
              activeCwd ? (
                <div className="h-full flex items-center justify-center text-text-muted text-[15px]">
                  {t("shell.selectSession")}
                </div>
              ) : (
                <div className="flex h-full flex-col items-center justify-center px-6 text-center select-none">
                  <div className="mb-3 grid h-10 w-10 place-items-center rounded-[13px] border border-border bg-bg-elevated font-mono text-[21px] font-semibold text-text-strong shadow-input">
                    π
                  </div>
                  <div className="text-[15px] font-medium text-text">{t("shell.openProject")}</div>
                  <div className="mt-1 max-w-64 text-[12px] leading-[1.6] text-text-muted">
                    {t("shell.openProjectHint")}
                  </div>
                </div>
              )
            ) : null}
          </div>

        </div>

        {/* Right panel: file viewer — always mounted, width animated via CSS */}
        <div
          className={`right-panel-container${rightPanelOpen ? " right-panel-open" : " right-panel-closed"}${resizingSide === "right" ? " is-resizing" : ""} flex flex-col border-l border-divider bg-bg relative`}
          style={{
            width: rightPanelOpen ? panelWidths.right : 0,
            minWidth: rightPanelOpen ? panelWidths.right : 0,
          }}
        >
          {rightPanelOpen && (
            <div
              className="panel-resize-handle panel-resize-handle-right"
              role="separator"
              aria-orientation="vertical"
              aria-label={t("shell.resizeFilePanel")}
              onPointerDown={(e) => beginPanelResize("right", e)}
            />
          )}
          {/* Right panel tab bar */}
          <div className="material-toolbar flex items-center shrink-0 border-b border-divider h-toolbar-height [-webkit-app-region:drag]">
            <div className="flex-1 overflow-hidden [-webkit-app-region:no-drag]">
              <TabBar
                tabs={fileTabs}
                activeTabId={activeFileTabId ?? ""}
                onSelectTab={setActiveFileTabId}
                onCloseTab={handleCloseFileTab}
              />
            </div>
            <button
              onClick={() => setRightPanelOpen(false)}
              title={t("shell.hideFilePanel")}
              aria-label={t("shell.hideFilePanel")}
              className="flex items-center justify-center w-9 h-full p-0 bg-transparent border-none border-l border-divider text-text hover:text-text cursor-pointer shrink-0 transition-colors duration-150 [-webkit-app-region:no-drag]"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="15" y1="3" x2="15" y2="21" />
              </svg>
            </button>
            <div className="w-titlebar shrink-0" />
          </div>

          {/* File content */}
          <div className="flex-1 overflow-hidden">
            {activeFileTab?.filePath ? (
              <FileViewer filePath={activeFileTab.filePath} cwd={activeCwd ?? undefined} />
            ) : (
              <div className="h-full flex items-center justify-center text-text-dim text-[12px]">{t("shell.noFileOpen")}</div>
            )}
          </div>
        </div>
      </div>

      {modelsConfigOpen && (
        <ModelsConfig
          onClose={() => {
            setModelsConfigOpen(false);
            setModelsRefreshKey((k) => k + 1);
          }}
        />
      )}
      {skillsConfigOpen && (activeCwd ?? selectedSession?.cwd ?? newSessionCwd) && (
        <SkillsConfig
          cwd={(activeCwd ?? selectedSession?.cwd ?? newSessionCwd)!}
          onClose={() => setSkillsConfigOpen(false)}
        />
      )}
      {/* Wave 2 Modals */}
      <ExtensionsConfigModal
        isOpen={extensionsModalOpen}
        onClose={() => setExtensionsModalOpen(false)}
        cwd={activeCwd ?? selectedSession?.cwd ?? newSessionCwd ?? undefined}
      />
      <SessionExportModal
        isOpen={exportModalOpen}
        onClose={() => setExportModalOpen(false)}
        sessionId={exportSessionId ?? selectedSession?.id ?? null}
      />
      <BranchCloneModal
        isOpen={branchCloneModal.isOpen}
        onClose={() => setBranchCloneModal((prev) => ({ ...prev, isOpen: false }))}
        mode={branchCloneModal.mode}
        sessionId={branchCloneModal.sessionId}
        targetEntryId={branchCloneModal.targetEntryId}
        cwd={activeCwd ?? selectedSession?.cwd ?? undefined}
        onSuccess={(newId) => handleSessionForked(newId)}
      />
    </>
  );
}
