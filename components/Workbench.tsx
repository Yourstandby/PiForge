"use client";

import { useCallback, useEffect, useState } from "react";
import type { SessionInfo } from "@/lib/types";
import { getElectronApi } from "@/lib/electron-api";
import { buildProjectWindowPath, resolveInitialView } from "@/lib/project-window";
import { ChatSurface } from "./ChatSurface";
import { FilePanel } from "./FilePanel";
import { FileViewerPanel } from "./FileViewerPanel";
import { McpSettingsModal } from "./McpSettingsModal";
import { ModelsConfig } from "./ModelsConfig";
import { SessionRail } from "./SessionRail";
import { SkillsConfig } from "./SkillsConfig";
import { TitleBar } from "./TitleBar";

function byModifiedDesc(a: SessionInfo, b: SessionInfo): number {
  return new Date(b.modified).getTime() - new Date(a.modified).getTime();
}

type SettingsModal = "skills" | "mcp" | "models" | null;

export function Workbench() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
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
  const [settingsModal, setSettingsModal] = useState<SettingsModal>(null);
  const [openFile, setOpenFile] = useState<{ path: string; name: string } | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);

  const loadSessions = useCallback(async (): Promise<SessionInfo[]> => {
    try {
      const res = await fetch("/api/sessions");
      if (!res.ok) return [];
      const data = (await res.json()) as { sessions?: SessionInfo[] };
      const sorted = [...(data.sessions ?? [])].sort(byModifiedDesc);
      setSessions(sorted);
      return sorted;
    } catch {
      return [];
    } finally {
      setLoading(false);
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

  const handleNewSession = async () => {
    let target = cwd;
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
  };

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden bg-white">
      <TitleBar cwd={cwd} />

      <div className="flex min-h-0 flex-1">
        <SessionRail
          sessions={sessions}
          loading={loading}
          selectedId={selected?.id ?? null}
          error={projectError}
          onSelect={handleSelect}
          onNewSession={() => {
            void handleNewSession();
          }}
          onAddProject={() => {
            void handleAddProject();
          }}
          onOpenSkills={() => setSettingsModal("skills")}
          onOpenMcp={() => setSettingsModal("mcp")}
          onOpenModels={() => setSettingsModal("models")}
        />

        <div className="relative flex min-w-0 flex-1">
          <ChatSurface
            key={chatKey}
            session={selected}
            newSessionCwd={newSessionCwd}
            draft={draft}
            modelsRefreshKey={modelsVersion}
            onDraftChange={setDraft}
            onSessionCreated={handleSessionCreated}
          />
          {openFile && (
            <FileViewerPanel
              filePath={openFile.path}
              cwd={cwd}
              onClose={() => setOpenFile(null)}
            />
          )}
        </div>

        <FilePanel cwd={cwd} onOpenFile={(path, name) => setOpenFile({ path, name })} />
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
    </div>
  );
}

export default Workbench;
