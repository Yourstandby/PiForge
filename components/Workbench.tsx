"use client";

import { useCallback, useEffect, useState } from "react";
import type { SessionInfo } from "@/lib/types";
import { getElectronApi } from "@/lib/electron-api";
import { resolveForkedSession } from "@/lib/fork-session-wait";
import { buildProjectWindowPath, resolveInitialView } from "@/lib/project-window";
import { useFileTabs } from "@/hooks/useFileTabs";
import { ChatSurface } from "./ChatSurface";
import { FilePanel } from "./FilePanel";
import { FileViewer } from "./FileViewer";
import { McpSettingsModal } from "./McpSettingsModal";
import { ModelsConfig } from "./ModelsConfig";
import { SessionExportModal } from "./SessionExportModal";
import { SessionSidebar } from "./SessionSidebar";
import { SkillsConfig } from "./SkillsConfig";
import { TabBar } from "./TabBar";
import { TitleBar } from "./TitleBar";

function byModifiedDesc(a: SessionInfo, b: SessionInfo): number {
  return new Date(b.modified).getTime() - new Date(a.modified).getTime();
}

type SettingsModal = "skills" | "mcp" | "models" | null;

export function Workbench() {
  const [selected, setSelected] = useState<SessionInfo | null>(null);
  const [newSessionCwd, setNewSessionCwd] = useState<string | null>(null);
  const [cwd, setCwd] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // Mirrors AppShell's sessionKey: remount the chat surface so all
  // session-scoped hook state starts clean on every switch.
  const [chatKey, setChatKey] = useState(0);
  // Bumped when the models modal closes so a freshly added provider shows up
  // in the model picker without remounting the session.
  const [modelsVersion, setModelsVersion] = useState(0);
  // Sidebar refetch trigger (fork / delete / new session).
  const [sessionsVersion, setSessionsVersion] = useState(0);
  const [settingsModal, setSettingsModal] = useState<SettingsModal>(null);
  const [exportSessionId, setExportSessionId] = useState<string | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);

  const {
    fileTabs,
    activeFileTabId,
    setActiveFileTabId,
    handleOpenFile,
    handleCloseFileTab,
  } = useFileTabs();

  const activeTab = fileTabs.find((tab) => tab.id === activeFileTabId) ?? null;

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
    setDraft("");
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
      <TitleBar cwd={cwd} />

      <div className="flex min-h-0 flex-1">
        <div className="flex w-[260px] shrink-0 flex-col border-r border-gray-200/60 bg-[#F5F5F7]">
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
            onAtMention={(relativePath) => {
              setDraft((value) => `${value}${value && !value.endsWith(" ") ? " " : ""}@${relativePath} `);
            }}
          />
          <div className="shrink-0 border-t border-gray-200/60 p-2">
            {projectError && (
              <p role="status" className="px-1 pb-1.5 text-[11px] text-[#c2554e]">
                {projectError}
              </p>
            )}
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  void handleAddProject();
                }}
                title="打开项目文件夹（新窗口）"
                aria-label="打开项目文件夹（新窗口）"
                className="flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border border-[#E4E4E0] bg-white text-[12px] text-ink-muted transition-colors duration-150 hover:border-[#CFDDFA] hover:text-accent-strong"
              >
                添加项目…
              </button>
              <button
                type="button"
                onClick={() => setSettingsModal("models")}
                title="模型与登录"
                aria-label="模型与登录"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[#E4E4E0] bg-white text-ink-muted transition-colors duration-150 hover:border-[#CFDDFA] hover:text-accent-strong"
              >
                ⚙
              </button>
            </div>
            <div className="mt-1.5 flex gap-1.5">
              <button
                type="button"
                onClick={() => setSettingsModal("skills")}
                className="flex-1 rounded-lg px-2 py-1 text-[11px] text-ink-muted transition-colors duration-150 hover:bg-[#ECECEF] hover:text-ink"
              >
                技能
              </button>
              <button
                type="button"
                onClick={() => setSettingsModal("mcp")}
                className="flex-1 rounded-lg px-2 py-1 text-[11px] text-ink-muted transition-colors duration-150 hover:bg-[#ECECEF] hover:text-ink"
              >
                MCP
              </button>
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
            onDraftChange={setDraft}
            onSessionCreated={handleSessionCreated}
            onSessionForked={(newSessionId) => {
              void handleSessionForked(newSessionId);
            }}
          />
          {activeTab && (
            <div
              className="absolute inset-0 z-30 flex flex-col bg-[#FCFCFA]"
              style={{ ["--toolbar-height" as string]: "34px" }}
            >
              <TabBar
                tabs={fileTabs}
                activeTabId={activeTab.id}
                onSelectTab={setActiveFileTabId}
                onCloseTab={handleCloseFileTab}
              />
              <div className="min-h-0 flex-1 overflow-hidden border-t border-[#EBEDF1]">
                <FileViewer filePath={activeTab.filePath} cwd={cwd ?? undefined} />
              </div>
            </div>
          )}
        </div>

        <FilePanel cwd={cwd} onOpenFile={(path, name) => handleOpenFile(path, name)} />
      </div>

      {settingsModal === "skills" && (
        <SkillsConfig cwd={cwd ?? ""} onClose={() => setSettingsModal(null)} />
      )}
      {settingsModal === "mcp" && (
        <McpSettingsModal cwd={cwd ?? ""} onClose={() => setSettingsModal(null)} />
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
