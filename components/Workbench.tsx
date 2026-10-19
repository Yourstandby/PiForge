"use client";

import { useEffect, useMemo, useState } from "react";
import type { SessionInfo } from "@/lib/types";
import { Composer } from "./Composer";
import { FilePanel } from "./FilePanel";
import { SessionRail } from "./SessionRail";

export function Workbench() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/sessions")
      .then((res) => (res.ok ? res.json() : { sessions: [] }))
      .then((data: { sessions?: SessionInfo[] }) => {
        if (cancelled) return;
        const list = Array.isArray(data.sessions) ? data.sessions : [];
        setSessions(
          [...list].sort(
            (a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime(),
          ),
        );
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

  const selected = useMemo(
    () => sessions.find((session) => session.id === selectedId) ?? null,
    [sessions, selectedId],
  );

  // The file tree follows the selected session; without a selection it shows
  // the most recent project so the panel is never empty for returning users.
  const cwd = selected?.cwd ?? sessions[0]?.cwd ?? null;

  return (
    <div className="flex h-screen w-full overflow-hidden bg-white">
      <SessionRail
        sessions={sessions}
        loading={loading}
        selectedId={selectedId}
        onSelect={(session) => setSelectedId(session.id)}
        onNewSession={() => setSelectedId(null)}
      />

      <main className="flex min-w-0 flex-1 items-center justify-center bg-white px-6">
        <div className="flex w-full max-w-3xl flex-col items-center">
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
            PiForge
          </h1>
          <div className="mt-6 w-full">
            <Composer />
          </div>
        </div>
      </main>

      <FilePanel cwd={cwd} />
    </div>
  );
}

export default Workbench;
