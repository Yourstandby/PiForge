"use client";

import { useEffect, useState } from "react";
import type { AgentMessage, SessionInfo } from "@/lib/types";
import { Composer } from "./Composer";
import { FilePanel } from "./FilePanel";
import { SessionRail } from "./SessionRail";
import { Transcript } from "./Transcript";

export function Workbench() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cwd, setCwd] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentMessage[] | null>(null);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    let cancelled = false;

    fetch("/api/sessions")
      .then((res) => (res.ok ? res.json() : { sessions: [] }))
      .then((data: { sessions?: SessionInfo[] }) => {
        if (cancelled) return;
        const list = Array.isArray(data.sessions) ? data.sessions : [];
        const sorted = [...list].sort(
          (a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime(),
        );
        setSessions(sorted);

        // Deep link (?session=<id>, used by desktop project windows).
        const deepLinkId = new URLSearchParams(window.location.search).get("session");
        const linked = deepLinkId ? sorted.find((session) => session.id === deepLinkId) : null;
        if (linked) {
          setSelectedId(linked.id);
          setCwd(linked.cwd);
          return;
        }

        // The file tree starts on the most recent project; it then stays put
        // when the user starts a fresh session or switches conversations.
        setCwd((current) => current ?? sorted[0]?.cwd ?? null);
      })
      .catch(() => {
        // Browsing history is read-only; an unreachable API just shows an empty list.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Load the selected conversation from the session file via the read-only API.
  useEffect(() => {
    if (!selectedId) {
      setMessages(null);
      setChatError(null);
      return;
    }

    const controller = new AbortController();
    setChatLoading(true);
    setChatError(null);

    fetch(`/api/sessions/${encodeURIComponent(selectedId)}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<{ context?: { messages?: AgentMessage[] } }>;
      })
      .then((data) => {
        setMessages(Array.isArray(data.context?.messages) ? data.context.messages : []);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setMessages(null);
        setChatError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setChatLoading(false);
      });

    return () => controller.abort();
  }, [selectedId]);

  const handleSelect = (session: SessionInfo) => {
    setSelectedId(session.id);
    setCwd(session.cwd);
  };

  const handleNewSession = () => {
    setSelectedId(null);
    setMessages(null);
    setChatError(null);
    setDraft("");
    // cwd is intentionally left alone: the file tree keeps the current project.
  };

  const composer = (
    <Composer
      value={draft}
      onValueChange={setDraft}
      onSubmit={() => {
        // Sending is not wired yet; history browsing is read-only for now.
      }}
    />
  );

  return (
    <div className="flex h-screen w-full overflow-hidden bg-white">
      <SessionRail
        sessions={sessions}
        loading={loading}
        selectedId={selectedId}
        onSelect={handleSelect}
        onNewSession={handleNewSession}
      />

      <main className="flex min-w-0 flex-1 flex-col bg-[#FCFCFA]">
        {selectedId ? (
          <>
            <div key={selectedId} className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto w-full max-w-3xl px-8 py-10">
                {chatLoading ? (
                  <p className="py-10 text-center text-[13px] text-neutral-400">加载会话…</p>
                ) : chatError ? (
                  <div className="py-10 text-center">
                    <p className="text-[13px] text-neutral-500">无法加载这段会话</p>
                    <p className="mt-1 text-[11px] text-neutral-400">{chatError}</p>
                  </div>
                ) : (
                  <Transcript messages={messages ?? []} />
                )}
              </div>
            </div>
            <div className="shrink-0 px-8 pb-6">
              <div className="mx-auto w-full max-w-3xl">{composer}</div>
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center px-8">
            <div className="flex w-full max-w-3xl flex-col items-center">
              <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
                PiForge
              </h1>
              <div className="mt-6 w-full">{composer}</div>
            </div>
          </div>
        )}
      </main>

      <FilePanel cwd={cwd} />
    </div>
  );
}

export default Workbench;
