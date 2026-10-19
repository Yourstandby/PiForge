"use client";

import { useCallback, useEffect, useState } from "react";
import type { SessionInfo } from "@/lib/types";
import { ChatSurface } from "./ChatSurface";
import { FilePanel } from "./FilePanel";
import { SessionRail } from "./SessionRail";

function byModifiedDesc(a: SessionInfo, b: SessionInfo): number {
  return new Date(b.modified).getTime() - new Date(a.modified).getTime();
}

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

      const deepLinkId = new URLSearchParams(window.location.search).get("session");
      const linked = deepLinkId ? sorted.find((session) => session.id === deepLinkId) : null;
      if (linked) {
        setSelected(linked);
        setCwd(linked.cwd);
        return;
      }
      // Nothing selected: the hero composer is a brand-new session in the
      // most recent project, so the first message can be sent immediately.
      const projectCwd = sorted[0]?.cwd ?? null;
      setCwd((current) => current ?? projectCwd);
      setNewSessionCwd((current) => current ?? projectCwd);
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

  const handleSessionCreated = (created: SessionInfo) => {
    setSelected(created);
    setNewSessionCwd(null);
    if (created.cwd) setCwd(created.cwd);
    void loadSessions();
  };

  return (
    <div className="flex h-screen w-full overflow-hidden bg-white">
      <SessionRail
        sessions={sessions}
        loading={loading}
        selectedId={selected?.id ?? null}
        onSelect={handleSelect}
        onNewSession={() => {
          void handleNewSession();
        }}
      />

      <ChatSurface
        key={chatKey}
        session={selected}
        newSessionCwd={newSessionCwd}
        draft={draft}
        onDraftChange={setDraft}
        onSessionCreated={handleSessionCreated}
      />

      <FilePanel cwd={cwd} />
    </div>
  );
}

export default Workbench;
