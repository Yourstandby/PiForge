import type { SessionData } from "./use-session-loader";
import type { AgentMessage } from "@/lib/types";
import type { SessionBranches, SessionBranchSwitchResult } from "@contract/domains/sessions";

/** A hung Host/pipe must not leave the transcript spinner forever. */
export const SESSION_LOAD_DEADLINE_MS = 15_000;
/** One retry, per resilience requirement; no unbounded retry storms. */
export const SESSION_LOAD_RETRIES = 1;

export class SessionLoadTimeoutError extends Error {
  timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`Session load timed out after ${timeoutMs}ms`);
    this.name = "SessionLoadTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class SessionLoadHttpError extends Error {
  status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.name = "SessionLoadHttpError";
    this.status = status;
  }
}

export function isRetryableSessionLoadError(error: unknown): boolean {
  if (error instanceof SessionLoadTimeoutError) return true;
  if (error instanceof SessionLoadHttpError) return error.status >= 500;
  // fetch() rejects with TypeError on network failure / aborted pipe.
  return error instanceof TypeError;
}

/** Fetch + parse JSON with a hard deadline (covers a stalled body too). */
async function fetchJsonWithDeadline(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (res.status === 404) return null;
    if (!res.ok) throw new SessionLoadHttpError(res.status);
    return await res.json();
  } catch (error) {
    if (controller.signal.aborted) throw new SessionLoadTimeoutError(timeoutMs);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export interface FetchSessionOptions {
  timeoutMs?: number;
  retries?: number;
}

export async function fetchSession(
  sid: string,
  includeState = false,
  options: FetchSessionOptions = {},
): Promise<SessionData | null> {
  const url = includeState
    ? `/api/sessions/${encodeURIComponent(sid)}?includeState`
    : `/api/sessions/${encodeURIComponent(sid)}`;
  const timeoutMs = options.timeoutMs ?? SESSION_LOAD_DEADLINE_MS;
  const retries = Math.max(0, options.retries ?? SESSION_LOAD_RETRIES);
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchJsonWithDeadline(url, timeoutMs) as SessionData | null;
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !isRetryableSessionLoadError(error)) throw error;
    }
  }
  throw lastError;
}

export async function fetchContext(
  sid: string,
  leafId: string | null,
  options: { timeoutMs?: number } = {},
): Promise<{ context: { messages: AgentMessage[]; entryIds: string[] } }> {
  const url = leafId
    ? `/api/sessions/${encodeURIComponent(sid)}/context?leafId=${encodeURIComponent(leafId)}`
    : `/api/sessions/${encodeURIComponent(sid)}/context`;
  const body = await fetchJsonWithDeadline(url, options.timeoutMs ?? SESSION_LOAD_DEADLINE_MS);
  if (body === null) throw new SessionLoadHttpError(404);
  return body as { context: { messages: AgentMessage[]; entryIds: string[] } };
}

export async function fetchBranches(
  sid: string,
  filePath?: string | null,
  options: { timeoutMs?: number } = {},
): Promise<SessionBranches> {
  const query = filePath ? `?filePath=${encodeURIComponent(filePath)}` : "";
  const body = await fetchJsonWithDeadline(
    `/api/sessions/${encodeURIComponent(sid)}/branches${query}`,
    options.timeoutMs ?? SESSION_LOAD_DEADLINE_MS,
  );
  if (body === null) throw new SessionLoadHttpError(404);
  return body as SessionBranches;
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
