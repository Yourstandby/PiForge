import type { SessionData } from "./use-session-loader";
import type { AgentMessage } from "@/lib/types";
import type { SessionBranches, SessionBranchSwitchResult } from "@contract/domains/sessions";

export async function fetchSession(sid: string, includeState = false): Promise<SessionData | null> {
  const url = includeState
    ? `/api/sessions/${encodeURIComponent(sid)}?includeState`
    : `/api/sessions/${encodeURIComponent(sid)}`;
  const res = await fetch(url);
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json() as Promise<SessionData>;
}

export async function fetchContext(sid: string, leafId: string | null): Promise<{ context: { messages: AgentMessage[]; entryIds: string[] } }> {
  const url = leafId
    ? `/api/sessions/${encodeURIComponent(sid)}/context?leafId=${encodeURIComponent(leafId)}`
    : `/api/sessions/${encodeURIComponent(sid)}/context`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json() as Promise<{ context: { messages: AgentMessage[]; entryIds: string[] } }>;
}

export async function fetchBranches(
  sid: string,
  filePath?: string | null,
): Promise<SessionBranches> {
  const query = filePath ? `?filePath=${encodeURIComponent(filePath)}` : "";
  const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}/branches${query}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<SessionBranches>;
}

export async function switchBranchApi(
  sid: string,
  leafId: string | null,
  filePath?: string | null,
): Promise<SessionBranchSwitchResult> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}/branches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ leafId, ...(filePath ? { filePath } : {}) }),
  });
  const body = (await res.json()) as SessionBranchSwitchResult & { error?: string };
  if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}
