"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionInfo } from "@/lib/types";
import { PanelLeftOpen, PanelRightOpen, Plug, Settings, Sparkles } from "lucide-react";
import { getElectronApi } from "@/lib/electron-api";
import { resolveForkedSession } from "@/lib/fork-session-wait";
import { buildProjectWindowPath, resolveInitialView } from "@/lib/project-window";
import { useConfigHotReload } from "@/hooks/useConfigHotReload";
import { ChatSurface } from "./ChatSurface";
import { FilePanel } from "./FilePanel";
import { ModelsConfig } from "./ModelsConfig";
import { SessionExportModal } from "./SessionExportModal";
import { SessionSidebar } from "./SessionSidebar";
import { SessionTabBar } from "./SessionTabBar";
import { ExtensionsConfigModal } from "./ExtensionsConfigModal";
import { AutoRoutingConfig } from "./AutoRoutingConfig";
import { AuxModelsConfig } from "./AuxModelsConfig";
import { CustomProvidersConfig } from "./CustomProvidersConfig";
import { ApplyCodeModal } from "./ApplyCodeModal";
import { DevEnvironmentConfig } from "./DevEnvironmentConfig";
import { McpSettingsModal } from "./McpSettingsModal";
import type { FloatingFileTarget } from "./FloatingFileViewer";
import { SkillsConfig } from "./SkillsConfig";
import { TitleBar } from "./TitleBar";

function byModifiedDesc(a: SessionInfo, b: SessionInfo): number {
  return new Date(b.modified).getTime() - new Date(a.modified).getTime();
}

type SettingsModal = "skills" | "models" | "extensions" | "auto" | "aux" | "mcp" | "dev" | "providers" | null;

const MIN_RIGHT_PANEL_WIDTH = 280;
const MAX_RIGHT_PANEL_WIDTH = 800;
const RIGHT_PANEL_WIDTH_KEY = "piforge.rightPanelWidth";

function clampRightPanelWidth(width: number): number {
  return Math.min(MAX_RIGHT_PANEL_WIDTH, Math.max(MIN_RIGHT_PANEL_WIDTH, Math.round(width)));
}

/**
 * One open chat tab. `key` is stable for the tab's lifetime (even when a
 * not-yet-created session adopts a real session id), so the mounted
 * ChatSurface never remounts and streaming state is preserved.
 */
interface ChatTab {
  key: string;
  title: string;
  session: SessionInfo | null;
  newSessionCwd: string | null;
  /** localStorage bucket for the composer draft. */
  draftKey: string;
}

let tabSeq = 0;

function tabTitle(session: SessionInfo | null): string {
  if (!session) return "新会话";
  const name = session.name?.trim();
  if (name) return name;
  const first = session.firstMessage?.replace(/\s+/g, " ").trim();
  if (first) return first.length > 48 ? `${first.slice(0, 47)}…` : first;
  return "未命名会话";
}

function draftKeyFor(session: SessionInfo | null, newSessionCwd: string | null): string {
  return session ? `session:${session.id}` : `new:${newSessionCwd ?? ""}`;
}

function readStoredDraft(draftKey: string): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(`piforge.draft:${draftKey}`) ?? "";
  } catch {
    return "";
  }
}

function makeTab(session: SessionInfo | null, newSessionCwd: string | null): ChatTab {
  tabSeq += 1;
  return {
    key: `tab-${tabSeq}`,
    title: tabTitle(session),
    session,
    newSessionCwd,
    draftKey: draftKeyFor(session, newSessionCwd),
  };
}

/** Memoized so typing in one tab never re-renders the others. */
const ChatPane = memo(ChatSurface);

export function Workbench() {
  const [tabs, setTabs] = useState<ChatTab[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  // Composer drafts per tab key; persisted to localStorage by draftKey.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const tabsRef = useRef<ChatTab[]>([]);
  const activeKeyRef = useRef<string | null>(null);
  const [cwd, setCwd] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<FloatingFileTarget | null>(null);
  // Bumped after an applied code block so the floating viewer refetches.
  const [fileViewerRefreshKey, setFileViewerRefreshKey] = useState(0);
  const [applyRequest, setApplyRequest] = useState<{
    code: string;
    language?: string;
    target: FloatingFileTarget;
  } | null>(null);
  const [gitTabSignal, setGitTabSignal] = useState(0);
  // Bumped when the models modal closes so a freshly added provider shows up
  // in the model picker without remounting the session.
  const [modelsVersion, setModelsVersion] = useState(0);
  // Sidebar refetch trigger (fork / delete / new session).
  const [sessionsVersion, setSessionsVersion] = useState(0);
  const [settingsModal, setSettingsModal] = useState<SettingsModal>(null);
  const [leftSidebarOpen, setLeftSidebarOpen] = useState(true);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [rightPanelWidth, setRightPanelWidth] = useState(560);
  const [rightPanelResizing, setRightPanelResizing] = useState(false);
  const rightPanelDragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // Responsive default + persisted user width; re-clamp when the window shrinks.
  useEffect(() => {
    let saved: number | null = null;
    try {
      const raw = window.localStorage.getItem(RIGHT_PANEL_WIDTH_KEY);
      const parsed = raw ? Number(raw) : NaN;
      if (Number.isFinite(parsed) && parsed > 0) saved = parsed;
    } catch {
      // storage disabled
    }
    const fallback = Math.min(800, Math.max(400, Math.round(window.innerWidth * 0.36)));
    setRightPanelWidth(clampRightPanelWidth(saved ?? fallback));
    const onWindowResize = () => {
      setRightPanelWidth((current) => clampRightPanelWidth(current));
    };
    window.addEventListener("resize", onWindowResize);
    return () => window.removeEventListener("resize", onWindowResize);
  }, []);

  const startRightPanelResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      rightPanelDragRef.current = { startX: event.clientX, startWidth: rightPanelWidth };
      setRightPanelResizing(true);
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [rightPanelWidth],
  );

  const moveRightPanelResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = rightPanelDragRef.current;
    if (!drag) return;
    setRightPanelWidth(clampRightPanelWidth(drag.startWidth + drag.startX - event.clientX));
  }, []);

  const endRightPanelResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = rightPanelDragRef.current;
      if (!drag) return;
      rightPanelDragRef.current = null;
      const finalWidth = clampRightPanelWidth(drag.startWidth + drag.startX - event.clientX);
      setRightPanelWidth(finalWidth);
      setRightPanelResizing(false);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // pointer already released
      }
      try {
        window.localStorage.setItem(RIGHT_PANEL_WIDTH_KEY, String(finalWidth));
      } catch {
        // storage disabled
      }
    },
    [],
  );

  // ~/.pi/agent edits (models.json, auth.json, extensions, skills) are picked
  // up live: bump the model list key and refresh sessions without a restart.
  useConfigHotReload(() => {
    setModelsVersion((version) => version + 1);
    setSessionsVersion((version) => version + 1);
  });
  const [exportSessionId, setExportSessionId] = useState<string | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  // ------------------------------------------------------------------ tabs
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.key === activeKey) ?? null,
    [tabs, activeKey],
  );
  const activeCwd = activeTab?.session?.cwd ?? activeTab?.newSessionCwd ?? cwd;

  // Switching tabs must re-read the tree even when two tabs share a cwd (an
  // agent may have changed files in between).
  const [explorerRefreshKey, setExplorerRefreshKey] = useState(0);
  useEffect(() => {
    setExplorerRefreshKey((value) => value + 1);
  }, [activeKey]);

  const commitTabs = useCallback((next: ChatTab[]) => {
    tabsRef.current = next;
    setTabs(next);
  }, []);

  const activateTab = useCallback((key: string) => {
    activeKeyRef.current = key;
    setActiveKey(key);
  }, []);

  /** Ctrl+Tab / Ctrl+Shift+Tab: cycle through the open session tabs. */
  const cycleTab = useCallback(
    (direction: 1 | -1) => {
      const list = tabsRef.current;
      if (list.length < 2) return;
      const current = list.findIndex((tab) => tab.key === activeKeyRef.current);
      if (current === -1) return;
      const next = list[(current + direction + list.length) % list.length];
      if (next) activateTab(next.key);
    },
    [activateTab],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (event.key !== "Tab") return;
      event.preventDefault();
      cycleTab(event.shiftKey ? -1 : 1);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [cycleTab]);

  const rememberDraft = useCallback((draftKey: string, value: string) => {
    try {
      if (value) window.localStorage.setItem(`piforge.draft:${draftKey}`, value);
      else window.localStorage.removeItem(`piforge.draft:${draftKey}`);
    } catch {
      // storage disabled: draft still works for this mount
    }
  }, []);

  const setDraftForTab = useCallback((key: string, value: string) => {
    setDrafts((prev) => (prev[key] === value ? prev : { ...prev, [key]: value }));
    const tab = tabsRef.current.find((item) => item.key === key);
    if (tab) rememberDraft(tab.draftKey, value);
  }, [rememberDraft]);

  const openTab = useCallback((tab: ChatTab) => {
    commitTabs([...tabsRef.current, tab]);
    setDrafts((prev) => ({ ...prev, [tab.key]: readStoredDraft(tab.draftKey) }));
    activateTab(tab.key);
  }, [commitTabs, activateTab]);

  const closeTab = useCallback(
    (key: string) => {
      const prev = tabsRef.current;
      const index = prev.findIndex((tab) => tab.key === key);
      if (index < 0) return;
      const next = prev.filter((tab) => tab.key !== key);

      if (next.length === 0) {
        // Closing the last tab lands on a fresh session tab, like a browser.
        const fresh = makeTab(null, cwd);
        commitTabs([fresh]);
        setDrafts((drafts) => ({ ...drafts, [fresh.key]: readStoredDraft(fresh.draftKey) }));
        activateTab(fresh.key);
        return;
      }

      commitTabs(next);
      if (activeKeyRef.current === key) {
        activateTab(next[Math.min(index, next.length - 1)].key);
      }
    },
    [commitTabs, activateTab, cwd],
  );

  // ------------------------------------------------------------------ files
  const handleOpenFile = useCallback(
    (filePath: string, fileName: string, line?: number) => {
      setOpenFile({ filePath, fileName, line });
    },
    [],
  );

  const handleOpenDiff = useCallback((filePath: string, fileName: string) => {
    setOpenFile({ filePath, fileName, diff: true });
  }, []);

  // The status bar's Git button focuses the right panel's Git tab.
  const handleOpenGitDiff = useCallback(() => {
    setRightPanelOpen(true);
    setGitTabSignal((value) => value + 1);
  }, []);

  const handleCloseFile = useCallback(() => setOpenFile(null), []);

  /** Apply a Markdown code block to the file open in the right panel. */
  const handleApplyCode = useCallback((code: string, language?: string) => {
    if (!openFile || openFile.diff) return;
    setApplyRequest({ code, language, target: openFile });
  }, [openFile]);

  const handleInsertCode = useCallback((code: string, language?: string) => {
    const key = activeKeyRef.current;
    if (!key) return;
    const fenced = `\`\`\`${language ?? ""}
${code}
\`\`\``;
    setDrafts((prev) => {
      const current = prev[key] ?? "";
      const next = current.trim()
        ? `${current.replace(/\s+$/, "")}

${fenced}`
        : fenced;
      const tab = tabsRef.current.find((item) => item.key === key);
      if (tab) rememberDraft(tab.draftKey, next);
      return { ...prev, [key]: next };
    });
  }, [rememberDraft]);

  const loadSessions = useCallback(async (): Promise<SessionInfo[]> => {
    try {
      const res = await fetch("/api/sessions");
      if (!res.ok) return [];
      const data = (await res.json()) as { sessions?: SessionInfo[] };
      const sorted = [...(data.sessions ?? [])].sort(byModifiedDesc);
      return sorted;
    } catch {
      return [];
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const initialize = async (sorted: SessionInfo[]) => {
      // Strict-mode double mount / hot reload must not open duplicate tabs.
      if (tabsRef.current.length > 0) return;

      const view = resolveInitialView(window.location.search, sorted);
      if (view.kind === "project") {
        // Electron opens `/?cwd=<project>` for a new project window: start a
        // blank session in that folder, not the newest on-disk session.
        setCwd(view.cwd);
        openTab(makeTab(null, view.cwd));
        return;
      }
      if (view.kind === "session") {
        setCwd(view.session.cwd);
        openTab(makeTab(view.session, null));
        return;
      }
      // Nothing selected: the hero composer is a brand-new session in the
      // most recent project, so the first message can be sent immediately.
      setCwd((current) => current ?? view.cwd);
      if (view.cwd) {
        openTab(makeTab(null, view.cwd));
        return;
      }
      // No project at all: ask the server for a default so the first prompt
      // still has somewhere to run.
      let fallback: string | null = null;
      try {
        const res = await fetch("/api/default-cwd", { method: "POST" });
        if (res.ok) fallback = ((await res.json()) as { cwd?: string }).cwd ?? null;
      } catch {
        // Keep the empty-project hero; the server will reject the first send.
      }
      if (cancelled) return;
      if (fallback) setCwd(fallback);
      openTab(makeTab(null, fallback));
    };

    void loadSessions().then((sorted) => {
      if (cancelled) return;
      void initialize(sorted);
    });
    return () => {
      cancelled = true;
    };
  }, [loadSessions, openTab]);

  /**
   * Sidebar click: open the session in its own tab. Clicking an already-open
   * session just focuses that tab, and the current chat is never replaced.
   */
  const handleSelect = useCallback(
    (session: SessionInfo) => {
      const existing = tabsRef.current.find((tab) => tab.session?.id === session.id);
      if (existing) {
        activateTab(existing.key);
        if (session.cwd) setCwd(session.cwd);
        return;
      }
      openTab(makeTab(session, null));
      if (session.cwd) setCwd(session.cwd);
    },
    [activateTab, openTab],
  );

  const handleNewSession = useCallback(async (targetCwd?: string) => {
    let target = targetCwd ?? activeCwd;
    if (!target) {
      try {
        const res = await fetch("/api/default-cwd", { method: "POST" });
        if (res.ok) {
          const data = (await res.json()) as { cwd?: string };
          target = data.cwd ?? null;
        }
      } catch {
        // Without a project folder there is nothing to create a session in.
      }
    }
    // A brand-new session tab can live without a project; the server picks
    // the default cwd when the first message is sent.
    if (target) setCwd(target);
    openTab(makeTab(null, target ?? null));
  }, [activeCwd, openTab]);

  /**
   * Picks a local folder and opens it as its own project window. In Electron
   * this goes through the preload bridge (`electronAPI.selectDirectory` /
   * `electronAPI.openWindow`); the browser dev build falls back to the
   * server-side Windows picker plus a new tab.
   */
  const handleAddProject = useCallback(async () => {
    setProjectError(null);
    const api = getElectronApi();

    let dir: string | null = null;
    if (api) {
      try {
        dir = await api.selectDirectory();
      } catch {
        setProjectError("无法打开文件夹选择器");
        return;
      }
    } else {
      try {
        const res = await fetch("/api/select-directory", { method: "POST" });
        if (!res.ok) {
          setProjectError("无法打开文件夹选择器");
          return;
        }
        dir = ((await res.json()) as { path?: string | null }).path ?? null;
      } catch {
        setProjectError("无法打开文件夹选择器");
        return;
      }
    }
    if (!dir) return;

    const path = buildProjectWindowPath(dir);
    if (api?.openWindow) {
      await api.openWindow(path);
      return;
    }
    window.open(path, "_blank", "noopener");
  }, []);

  /**
   * A prompt created a real session for a "新会话" tab: adopt its identity
   * without remounting the pane (streaming state stays intact).
   */
  const handleSessionCreated = useCallback(
    (key: string, created: SessionInfo) => {
      const tab = tabsRef.current.find((item) => item.key === key);
      if (!tab) return;
      const nextDraftKey = draftKeyFor(created, null);
      if (tab.draftKey !== nextDraftKey) {
        const stored = readStoredDraft(tab.draftKey);
        if (stored) rememberDraft(nextDraftKey, stored);
        rememberDraft(tab.draftKey, "");
      }
      commitTabs(
        tabsRef.current.map((item) =>
          item.key === key
            ? { ...item, session: created, newSessionCwd: null, title: tabTitle(created), draftKey: nextDraftKey }
            : item,
        ),
      );
      if (created.cwd) setCwd(created.cwd);
      setSessionsVersion((version) => version + 1);
      // The background auto-title finishes a few seconds into the first turn.
      // If its SSE event raced the sidebar's first refresh (or the stream was
      // reconnected), this one-shot refetch still picks the name up.
      window.setTimeout(() => {
        void loadSessions();
        setSessionsVersion((version) => version + 1);
      }, 6000);
    },
    [commitTabs, loadSessions, rememberDraft],
  );

  /** Keep tab titles in sync with auto-title / rename events. */
  const handleSessionRenamed = useCallback(async () => {
    setSessionsVersion((version) => version + 1);
    const sorted = await loadSessions();
    const byId = new Map(sorted.map((item) => [item.id, item]));
    commitTabs(
      tabsRef.current.map((tab) => {
        const fresh = tab.session ? byId.get(tab.session.id) : null;
        return fresh ? { ...tab, title: tabTitle(fresh) } : tab;
      }),
    );
  }, [commitTabs, loadSessions]);

  /**
   * A fork / branch-clone writes a new `.jsonl` server-side; the sidebar may not
   * see it for a moment, so resolve it with retries and then open it as a tab.
   */
  const handleSessionForked = useCallback(
    async (newSessionId: string) => {
      const found = await resolveForkedSession(
        newSessionId,
        async () => {
          try {
            const res = await fetch("/api/sessions");
            if (!res.ok) return [];
            const data = (await res.json()) as { sessions?: SessionInfo[] };
            return data.sessions ?? [];
          } catch {
            return [];
          }
        },
        async (id) => {
          try {
            const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
            if (!res.ok) return null;
            const data = (await res.json()) as { info?: SessionInfo | null };
            return data.info ?? null;
          } catch {
            return null;
          }
        },
      );
      const sorted = await loadSessions();
      setSessionsVersion((version) => version + 1);
      const target = found ?? sorted.find((item) => item.id === newSessionId) ?? null;
      if (!target) return;
      handleSelect(target);
    },
    [handleSelect, loadSessions],
  );

  /** A deleted session closes its tab(s); the chat area falls back to another. */
  const handleSessionDeleted = useCallback(
    (sessionId: string) => {
      const affected = tabsRef.current.filter((tab) => tab.session?.id === sessionId);
      if (affected.length > 0) {
        affected.forEach((tab) => closeTab(tab.key));
      }
      void loadSessions();
    },
    [closeTab, loadSessions],
  );

  /** File links in any transcript always land in the right panel. */
  const handleOpenChatFile = useCallback(
    (filePath: string, fileName: string, line?: number) => {
      setRightPanelOpen(true);
      handleOpenFile(filePath, fileName, line);
    },
    [handleOpenFile],
  );

  // Per-tab callbacks are cached by tab key so ChatPane's memo() holds: typing
  // in one tab only re-renders that tab.
  const paneActionsRef = useRef({ setDraftForTab, handleSessionCreated, handleNewSession });
  useEffect(() => {
    paneActionsRef.current = { setDraftForTab, handleSessionCreated, handleNewSession };
  }, [setDraftForTab, handleSessionCreated, handleNewSession]);

  const paneHandlers = useMemo(() => {
    const map = new Map<
      string,
      {
        onDraftChange: (value: string) => void;
        onSessionCreated: (session: SessionInfo) => void;
        onNewSession: () => void;
      }
    >();
    for (const tab of tabs) {
      const key = tab.key;
      const projectCwd = tab.session?.cwd ?? tab.newSessionCwd ?? null;
      map.set(key, {
        onDraftChange: (value) => paneActionsRef.current.setDraftForTab(key, value),
        onSessionCreated: (session) => paneActionsRef.current.handleSessionCreated(key, session),
        onNewSession: () => {
          void paneActionsRef.current.handleNewSession(projectCwd ?? undefined);
        },
      });
    }
    return map;
  }, [tabs]);

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden bg-white">
      <TitleBar />

      <div className="flex min-h-0 flex-1">
        <div
          className={`shrink-0 overflow-hidden transition-all duration-300 ${
            leftSidebarOpen ? "w-[260px]" : "w-0"
          }`}
          aria-hidden={!leftSidebarOpen}
        >
          <div className="flex h-full w-[260px] flex-col overflow-hidden border-r border-black/[0.06] bg-white/70 backdrop-blur-md">
          <div className="flex min-h-0 flex-1 flex-col">
          <SessionSidebar
            selectedSessionId={activeTab?.session?.id ?? null}
            onSelectSession={handleSelect}
            onNewSession={(_sessionId, targetCwd) => {
              void handleNewSession(targetCwd);
            }}
            refreshKey={sessionsVersion}
            onSessionDeleted={handleSessionDeleted}
            onExportSession={(session) => setExportSessionId(session.id)}
            selectedCwd={activeCwd}
            onCwdChange={(nextCwd) => {
              setCwd(nextCwd);
              // A not-yet-created tab follows the project the user picked.
              const key = activeKeyRef.current;
              if (!key) return;
              commitTabs(
                tabsRef.current.map((tab) =>
                  tab.key === key && !tab.session
                    ? { ...tab, newSessionCwd: nextCwd, draftKey: draftKeyFor(null, nextCwd) }
                    : tab,
                ),
              );
            }}
            onOpenFile={(filePath, fileName) => handleOpenFile(filePath, fileName)}
            onCollapse={() => setLeftSidebarOpen(false)}
            onAtMention={(relativePath) => {
              const key = activeKeyRef.current;
              if (!key) return;
              const current = drafts[key] ?? "";
              setDraftForTab(key, `${current}${current && !current.endsWith(" ") ? " " : ""}@${relativePath} `);
            }}
          />
          </div>
          <div className="relative shrink-0 border-t border-gray-200/60 p-2">
            {projectError && (
              <p role="status" className="px-1 pb-1 text-[11px] text-[#c2554e]">
                {projectError}
              </p>
            )}
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setSettingsModal("skills")}
                title="Skill"
                aria-label="Skill"
                className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 transition-colors duration-150 hover:bg-gray-100 hover:text-gray-900"
              >
                <Sparkles size={16} strokeWidth={1.75} className="h-4 w-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => setSettingsModal("mcp")}
                title="MCP"
                aria-label="MCP"
                className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 transition-colors duration-150 hover:bg-gray-100 hover:text-gray-900"
              >
                <Plug size={16} strokeWidth={1.75} className="h-4 w-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => setMenuOpen((open) => !open)}
                title="设置"
                aria-label="设置"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted transition-colors duration-150 hover:bg-[#ECECEF] hover:text-ink"
              >
                <Settings size={16} strokeWidth={1.75} aria-hidden="true" />
              </button>
            </div>
            {menuOpen && (
              <div className="material-popover absolute bottom-full left-2 right-2 z-[60] mb-1 rounded-xl p-1.5">
                {[
                  { label: "模型与登录", action: () => setSettingsModal("models") },
                  { label: "Auto 路由", action: () => setSettingsModal("auto") },
                  { label: "辅助模型（生图 / 决策）", action: () => setSettingsModal("aux") },
                  { label: "自定义 Provider（Ollama / 网关）", action: () => setSettingsModal("providers") },
                  { label: "开发环境与浏览器权限", action: () => setSettingsModal("dev") },
                  { label: "扩展与集成", action: () => setSettingsModal("extensions") },
                  { label: "技能安装", action: () => setSettingsModal("skills") },
                  { label: "添加项目…", action: () => { void handleAddProject(); } },
                ].map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      item.action();
                    }}
                    className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-[12.5px] text-ink-muted transition-colors duration-150 hover:bg-[#ECECEF] hover:text-ink"
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          </div>
        </div>

        <div className="relative flex min-w-0 flex-1 flex-col">
          <SessionTabBar
            tabs={tabs.map((tab) => ({
              key: tab.key,
              title: tab.title,
              sessionId: tab.session?.id ?? null,
              cwd: tab.session?.cwd ?? tab.newSessionCwd,
            }))}
            activeKey={activeKey}
            onSelect={activateTab}
            onClose={closeTab}
            onNew={() => {
              void handleNewSession();
            }}
          />

          <div className="relative flex min-h-0 min-w-0 flex-1">
            {/* Every open tab stays mounted: streaming, scroll position and
                draft survive switching. Inactive panes are just hidden. */}
            {tabs.map((tab) => {
              const handlers = paneHandlers.get(tab.key);
              if (!handlers) return null;
              return (
                <div
                  key={tab.key}
                  className={tab.key === activeKey ? "flex min-h-0 min-w-0 flex-1" : "hidden"}
                >
                  <ChatPane
                    session={tab.session}
                    newSessionCwd={tab.newSessionCwd}
                    draft={drafts[tab.key] ?? ""}
                    active={tab.key === activeKey}
                    modelsRefreshKey={modelsVersion}
                    onDraftChange={handlers.onDraftChange}
                    onSessionCreated={handlers.onSessionCreated}
                    onSessionRenamed={handleSessionRenamed}
                    onNewSession={handlers.onNewSession}
                    onInsertCode={handleInsertCode}
                    applyTargetName={openFile && !openFile.diff ? openFile.fileName : null}
                    onApplyCode={handleApplyCode}
                    onOpenGitDiff={handleOpenGitDiff}
                    onOpenFile={handleOpenChatFile}
                    onSessionForked={handleSessionForked}
                  />
                </div>
              );
            })}

            {!leftSidebarOpen && (
              <button
                type="button"
                onClick={() => setLeftSidebarOpen(true)}
                aria-label="展开左侧边栏"
                title="展开左侧边栏"
                className="absolute left-2 top-2 z-20 flex h-7 w-7 items-center justify-center rounded-md border border-gray-200/70 bg-white/90 text-gray-500 shadow-[0_2px_8px_rgba(0,0,0,0.06)] backdrop-blur transition-colors hover:text-gray-800"
              >
                <PanelLeftOpen size={16} strokeWidth={1.75} className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
            {!rightPanelOpen && (
              <button
                type="button"
                onClick={() => setRightPanelOpen(true)}
                aria-label="展开右侧面板"
                title="展开右侧面板"
                className="absolute right-2 top-2 z-20 flex h-7 w-7 items-center justify-center rounded-md border border-gray-200/70 bg-white/90 text-ink-muted shadow-[0_2px_8px_rgba(0,0,0,0.06)] backdrop-blur transition-colors hover:bg-[#ECECEF] hover:text-ink"
              >
                <PanelRightOpen size={14} strokeWidth={1.75} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>

        <div
          className={`relative shrink-0 overflow-hidden ${
            rightPanelResizing
              ? ""
              : "transition-[width] duration-200 ease-in-out"
          } ${rightPanelOpen ? "" : "pointer-events-none"}`}
          style={{ width: rightPanelOpen ? rightPanelWidth : 0 }}
          aria-hidden={!rightPanelOpen}
        >
          {rightPanelOpen && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="调整右侧面板宽度"
              title="拖动调整右侧面板宽度"
              onPointerDown={startRightPanelResize}
              onPointerMove={moveRightPanelResize}
              onPointerUp={endRightPanelResize}
              onPointerCancel={endRightPanelResize}
              className="absolute inset-y-0 left-0 z-30 w-1 touch-none cursor-col-resize bg-transparent transition-colors hover:bg-[#D9E5FB] active:bg-accent/30"
              style={{ touchAction: "none" }}
            />
          )}
          <FilePanel
            cwd={activeCwd}
            explorerRefreshKey={explorerRefreshKey}
            viewerRefreshKey={fileViewerRefreshKey}
            openFile={openFile}
            gitOpenSignal={gitTabSignal}
            onOpenFile={handleOpenFile}
            onOpenDiff={handleOpenDiff}
            onCloseFile={handleCloseFile}
            onCollapse={() => setRightPanelOpen(false)}
          />
        </div>
      </div>

      {settingsModal === "skills" && (
        <SkillsConfig cwd={activeCwd ?? ""} onClose={() => setSettingsModal(null)} />
      )}
      {settingsModal === "mcp" && (
        <McpSettingsModal cwd={activeCwd ?? ""} onClose={() => setSettingsModal(null)} />
      )}
      {settingsModal === "auto" && (
        <AutoRoutingConfig
          onClose={() => {
            setSettingsModal(null);
            setModelsVersion((version) => version + 1);
          }}
        />
      )}
      {settingsModal === "aux" && (
        <AuxModelsConfig onClose={() => setSettingsModal(null)} />
      )}
      {settingsModal === "dev" && (
        <DevEnvironmentConfig onClose={() => setSettingsModal(null)} />
      )}
      {settingsModal === "providers" && (
        <CustomProvidersConfig
          onClose={() => {
            setSettingsModal(null);
            setModelsVersion((version) => version + 1);
          }}
        />
      )}
      {applyRequest && (
        <ApplyCodeModal
          target={applyRequest.target}
          code={applyRequest.code}
          language={applyRequest.language}
          cwd={activeCwd}
          onClose={() => setApplyRequest(null)}
          onApplied={() => {
            setExplorerRefreshKey((key) => key + 1);
            setFileViewerRefreshKey((key) => key + 1);
          }}
        />
      )}
      {settingsModal === "extensions" && (
        <ExtensionsConfigModal
          isOpen
          cwd={cwd ?? undefined}
          initialTab="extensions"
          onClose={() => setSettingsModal(null)}
        />
      )}
      {settingsModal === "models" && (
        <ModelsConfig
          onClose={() => {
            setSettingsModal(null);
            setModelsVersion((version) => version + 1);
          }}
        />
      )}
      <SessionExportModal
        isOpen={exportSessionId !== null}
        onClose={() => setExportSessionId(null)}
        sessionId={exportSessionId}
      />
    </div>
  );
}

export default Workbench;
