"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import { ExtensionsConfigModal } from "./ExtensionsConfigModal";
import { AutoRoutingConfig } from "./AutoRoutingConfig";
import { McpSettingsModal } from "./McpSettingsModal";
import type { FloatingFileTarget } from "./FloatingFileViewer";
import { SkillsConfig } from "./SkillsConfig";
import { TitleBar } from "./TitleBar";

function byModifiedDesc(a: SessionInfo, b: SessionInfo): number {
  return new Date(b.modified).getTime() - new Date(a.modified).getTime();
}

type SettingsModal = "skills" | "models" | "extensions" | "auto" | "mcp" | null;

const MIN_RIGHT_PANEL_WIDTH = 280;
const MAX_RIGHT_PANEL_WIDTH = 800;
const RIGHT_PANEL_WIDTH_KEY = "piforge.rightPanelWidth";

function clampRightPanelWidth(width: number): number {
  return Math.min(MAX_RIGHT_PANEL_WIDTH, Math.max(MIN_RIGHT_PANEL_WIDTH, Math.round(width)));
}

export function Workbench() {
  const [selected, setSelected] = useState<SessionInfo | null>(null);
  const [newSessionCwd, setNewSessionCwd] = useState<string | null>(null);
  const [cwd, setCwd] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [openFile, setOpenFile] = useState<FloatingFileTarget | null>(null);
  const draftKeyRef = useRef<string>("");
  // Mirrors AppShell's sessionKey: remount the chat surface so all
  // session-scoped hook state starts clean on every switch.
  const [chatKey, setChatKey] = useState(0);
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

  // Drafts survive session switches and app restarts, one bucket per session
  // (or per project for a not-yet-created session).
  const draftKey = selected?.id
    ? `session:${selected.id}`
    : `new:${newSessionCwd ?? cwd ?? ""}`;
  useEffect(() => {
    draftKeyRef.current = draftKey;
    let stored = "";
    try {
      stored = window.localStorage.getItem(`piforge.draft:${draftKey}`) ?? "";
    } catch {
      // storage disabled
    }
    setDraft(stored);
  }, [draftKey]);

  const handleDraftChange = useCallback((next: string) => {
    setDraft(next);
    try {
      if (next) window.localStorage.setItem(`piforge.draft:${draftKeyRef.current}`, next);
      else window.localStorage.removeItem(`piforge.draft:${draftKeyRef.current}`);
    } catch {
      // storage disabled: draft still works for this mount
    }
  }, []);

  const handleOpenFile = useCallback(
    (filePath: string, fileName: string, line?: number) => {
      setOpenFile({ filePath, fileName, line });
    },
    [],
  );

  const handleOpenDiff = useCallback((filePath: string, fileName: string) => {
    setOpenFile({ filePath, fileName, diff: true });
  }, []);

  const handleCloseFile = useCallback(() => setOpenFile(null), []);

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
    void loadSessions().then((sorted) => {
      if (cancelled) return;

      const view = resolveInitialView(window.location.search, sorted);
      if (view.kind === "project") {
        // Electron opens `/?cwd=<project>` for a new project window: start a
        // blank session in that folder, not the newest on-disk session.
        setCwd(view.cwd);
        setNewSessionCwd(view.cwd);
        return;
      }
      if (view.kind === "session") {
        setSelected(view.session);
        setCwd(view.session.cwd);
        return;
      }
      // Nothing selected: the hero composer is a brand-new session in the
      // most recent project, so the first message can be sent immediately.
      setCwd((current) => current ?? view.cwd);
      setNewSessionCwd((current) => current ?? view.cwd);
    });
    return () => {
      cancelled = true;
    };
  }, [loadSessions]);

  const handleSelect = (session: SessionInfo) => {
    setSelected(session);
    setNewSessionCwd(null);
    setCwd(session.cwd);
    setChatKey((key) => key + 1);
  };

  const handleNewSession = async (targetCwd?: string) => {
    let target = targetCwd ?? cwd;
    if (!target) {
      try {
        const res = await fetch("/api/default-cwd", { method: "POST" });
        if (res.ok) {
          const data = (await res.json()) as { cwd?: string };
          target = data.cwd ?? null;
          if (target) setCwd(target);
        }
      } catch {
        // Without a project folder there is nothing to create a session in.
      }
    }
    if (!target) return;

    setSelected(null);
    setNewSessionCwd(target);
    setChatKey((key) => key + 1);
  };

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

  const handleSessionCreated = (created: SessionInfo) => {
    setSelected(created);
    setNewSessionCwd(null);
    if (created.cwd) setCwd(created.cwd);
    void loadSessions();
    setSessionsVersion((version) => version + 1);
    // The background auto-title finishes a few seconds into the first turn.
    // If its SSE event raced the sidebar's first refresh (or the stream was
    // reconnected), this one-shot refetch still picks the name up.
    window.setTimeout(() => {
      void loadSessions();
      setSessionsVersion((version) => version + 1);
    }, 6000);
  };

  /**
   * A fork / branch-clone writes a new `.jsonl` server-side; the sidebar may not
   * see it for a moment, so resolve it with retries and then jump to it.
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
      setSelected(target);
      setNewSessionCwd(null);
      if (target.cwd) setCwd(target.cwd);
      setChatKey((key) => key + 1);
    },
    [loadSessions],
  );

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
            selectedSessionId={selected?.id ?? null}
            onSelectSession={(session) => handleSelect(session)}
            onNewSession={(_sessionId, targetCwd) => {
              void handleNewSession(targetCwd);
            }}
            refreshKey={sessionsVersion}
            onSessionDeleted={(sessionId) => {
              if (selected?.id === sessionId) {
                setSelected(null);
                setNewSessionCwd(cwd);
                setChatKey((key) => key + 1);
              }
              void loadSessions();
            }}
            onExportSession={(session) => setExportSessionId(session.id)}
            selectedCwd={cwd}
            onCwdChange={(nextCwd) => setCwd(nextCwd)}
            onOpenFile={(filePath, fileName) => handleOpenFile(filePath, fileName)}
            onCollapse={() => setLeftSidebarOpen(false)}
            onAtMention={(relativePath) => {
              setDraft((value) => `${value}${value && !value.endsWith(" ") ? " " : ""}@${relativePath} `);
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

        <div className="relative flex min-w-0 flex-1">
          <ChatSurface
            key={chatKey}
            session={selected}
            newSessionCwd={newSessionCwd}
            draft={draft}
            modelsRefreshKey={modelsVersion}
            onDraftChange={handleDraftChange}
            onSessionCreated={handleSessionCreated}
            onSessionRenamed={() => setSessionsVersion((version) => version + 1)}
            onOpenFile={(filePath, fileName, line) => {
              // Chat file links must land in the right panel, never over chat.
              setRightPanelOpen(true);
              handleOpenFile(filePath, fileName, line);
            }}
            onSessionForked={(newSessionId) => {
              void handleSessionForked(newSessionId);
            }}
          />
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
            cwd={cwd}
            openFile={openFile}
            onOpenFile={handleOpenFile}
            onOpenDiff={handleOpenDiff}
            onCloseFile={handleCloseFile}
            onCollapse={() => setRightPanelOpen(false)}
          />
        </div>
      </div>

      {settingsModal === "skills" && (
        <SkillsConfig cwd={cwd ?? ""} onClose={() => setSettingsModal(null)} />
      )}
      {settingsModal === "mcp" && (
        <McpSettingsModal cwd={cwd ?? ""} onClose={() => setSettingsModal(null)} />
      )}
      {settingsModal === "auto" && (
        <AutoRoutingConfig
          onClose={() => {
            setSettingsModal(null);
            setModelsVersion((version) => version + 1);
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
