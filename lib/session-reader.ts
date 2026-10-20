import { SessionManager, buildSessionProjection, getAgentDir } from "@earendil-works/pi-coding-agent";
import { getAgentHostClient } from "./agent-host-client.ts";
import type { SessionEntry, SessionInfo, SessionContext, SessionTreeNode, AssistantMessage, SessionHeader } from "./types.ts";
import type { SessionEntry as PiSessionEntry, SessionInfo as PiSessionInfo } from "@earendil-works/pi-coding-agent";
import { normalizeToolCalls } from "./normalize.ts";
import { readFile } from "fs/promises";
import { createReadStream } from "fs";
import {
  cacheSessionPathEntry,
  createSessionPathCacheState,
  getCachedSessionPath,
  invalidateSessionPathEntry,
  markSessionPathMiss,
  type SessionPathCacheState,
} from "./session-path-cache.ts";

export { getAgentDir };

// ============================================================================
// Session path cache: sessionId → absolute file path
// Stored in globalThis for hot-reload safety
// Positive + short-TTL negative cache (see session-path-cache.ts)
// ============================================================================
declare global {
  var __piforgeSessionPathCacheState: SessionPathCacheState | undefined;
}

function getPathCacheState(): SessionPathCacheState {
  if (!globalThis.__piforgeSessionPathCacheState) {
    globalThis.__piforgeSessionPathCacheState = createSessionPathCacheState();
  }
  return globalThis.__piforgeSessionPathCacheState;
}

function getPathCache(): Map<string, string> {
  return getPathCacheState().paths;
}

export function getSessionsDir(): string {
  return `${getAgentDir()}/sessions`;
}

export async function listAllSessions(): Promise<SessionInfo[]> {
  const piSessions: PiSessionInfo[] = await SessionManager.listAll();
  const pathToId = new Map<string, string>();
  for (const s of piSessions) pathToId.set(s.path, s.id);

  const state = getPathCacheState();
  return piSessions.map((s) => {
    // Populate path cache so resolveSessionPath works without a full scan
    cacheSessionPathEntry(state, s.id, s.path);
    const leafEntryId =
      typeof s === "object" && s !== null && "leafEntryId" in s && typeof s.leafEntryId === "string"
        ? s.leafEntryId
        : undefined;
    return {
      path: s.path,
      id: s.id,
      cwd: s.cwd,
      name: s.name,
      created: s.created instanceof Date ? s.created.toISOString() : String(s.created),
      modified: s.modified instanceof Date ? s.modified.toISOString() : String(s.modified),
      messageCount: s.messageCount,
      firstMessage: s.firstMessage || "(no messages)",
      parentSessionId: s.parentSessionPath ? pathToId.get(s.parentSessionPath) : undefined,
      leafEntryId,
    };
  });
}

export async function resolveSessionPath(sessionId: string): Promise<string | null> {
  const state = getPathCacheState();
  const cached = getCachedSessionPath(state, sessionId);
  if (cached.hit) return cached.path;

  // The active AgentSession lives in the Agent Host now. A session created
  // there may not be flushed to disk yet (fork/new-session window), so the
  // host is the only place that can resolve it. Session-only trust means the
  // lookup never leaks data: it returns a path already known to the host.
  if (cached.negative) {
    const livePath = await locateViaHost(sessionId);
    if (!livePath) return null;
    state.misses.delete(sessionId);
    cacheSessionPathEntry(state, sessionId, livePath);
    return livePath;
  }

  // Cache miss: scan all sessions to populate cache, then retry.
  await listAllSessions();
  const after = getPathCache().get(sessionId) ?? null;
  if (after) {
    state.misses.delete(sessionId);
    return after;
  }

  const livePath = await locateViaHost(sessionId);
  if (livePath) {
    state.misses.delete(sessionId);
    cacheSessionPathEntry(state, sessionId, livePath);
    return livePath;
  }

  markSessionPathMiss(state, sessionId);
  return null;
}

/** Ask the Agent Host for a live (possibly not-yet-flushed) session file. */
async function locateViaHost(sessionId: string): Promise<string | null> {
  try {
    const result = await getAgentHostClient().call(
      "sessions.locate",
      { sessionId },
      { timeoutMs: 1_500 },
    );
    return result.filePath ?? null;
  } catch {
    // Host down / not configured: fall back to the on-disk scan result.
    return null;
  }
}

export function cacheSessionPath(sessionId: string, filePath: string): void {
  cacheSessionPathEntry(getPathCacheState(), sessionId, filePath);
}

export function invalidateSessionPathCache(sessionId: string): void {
  invalidateSessionPathEntry(getPathCacheState(), sessionId);
}

export function readFirstLineAsync(filePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const stream = createReadStream(filePath, { encoding: "utf8", highWaterMark: 4096 });
    let buffer = "";
    let resolved = false;

    stream.on("data", (chunk: Uint8Array | string) => {
      buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      const idx = buffer.indexOf("\n");
      if (idx !== -1) {
        resolved = true;
        resolve(buffer.slice(0, idx));
        stream.destroy();
      }
    });

    stream.on("end", () => {
      if (!resolved) {
        resolve(buffer || null);
      }
    });

    stream.on("error", (err) => {
      console.error("Error reading first line from", filePath, err);
      if (!resolved) {
        resolve(null);
      }
    });
  });
}

export function buildTree(entries: SessionEntry[]): SessionTreeNode[] {
  const nodeMap = new Map<string, SessionTreeNode>();
  const labelsById = new Map<string, string>();

  for (const entry of entries) {
    if (entry.type === "label") {
      const l = entry as { type: "label"; targetId: string; label?: string };
      if (l.label) labelsById.set(l.targetId, l.label);
      else labelsById.delete(l.targetId);
    }
  }

  const roots: SessionTreeNode[] = [];
  for (const entry of entries) {
    nodeMap.set(entry.id, { entry, children: [], label: labelsById.get(entry.id) });
  }
  for (const entry of entries) {
    const node = nodeMap.get(entry.id)!;
    if (!entry.parentId) {
      roots.push(node);
    } else {
      const parent = nodeMap.get(entry.parentId);
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
  }

  const stack = [...roots];
  while (stack.length > 0) {
    const node = stack.pop()!;
    node.children.sort((a, b) => new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime());
    stack.push(...node.children);
  }
  return roots;
}

export function buildSessionContext(entries: SessionEntry[], leafId?: string | null): SessionContext {
  const piEntries = entries as unknown as PiSessionEntry[];
  const byId = new Map(piEntries.map((entry) => [entry.id, entry]));
  const piCtx = buildSessionProjection(piEntries, leafId, byId);
  // Pi 0.87+ context edits can omit or replace messages. Use upstream
  // provenance so entryIds stay aligned with the finalized messages.
  const entryIds = piCtx.entries.flatMap((entry) => entry.messages.map(() => entry.sourceEntry.id));

  // pi injects compaction summary as {role:"compactionSummary", summary, tokensBefore}.
  // Convert to {role:"user"} so MessageView can render it the same as before.
  const messages = (piCtx.messages as AssistantMessage[]).map((msg) => {
    const raw = msg as unknown as Record<string, unknown>;
    if (raw.role === "compactionSummary") {
      return {
        role: "user" as const,
        content: `*The conversation history before this point was compacted into the following summary:*\n\n${raw.summary ?? ""}`,
        timestamp: raw.timestamp as number | undefined,
      };
    }
    return normalizeToolCalls(msg);
  });

  return {
    messages,
    entryIds,
    thinkingLevel: piCtx.thinkingLevel,
    model: piCtx.model,
  };
}

export function getLeafId(entries: SessionEntry[]): string | null {
  if (entries.length === 0) return null;
  return entries[entries.length - 1].id;
}

export async function getSessionEntriesAsync(filePath: string): Promise<SessionEntry[]> {
  const content = await readFile(filePath, "utf8");
  const lines = content.split("\n");
  const entries: SessionEntry[] = [];
  for (const line of lines) {
    if (line.trim()) {
      try {
        entries.push(JSON.parse(line) as SessionEntry);
      } catch (err) {
        console.error("Failed to parse JSONL line:", line, err);
      }
    }
  }
  return entries;
}

export async function getHeaderAsync(filePath: string): Promise<SessionHeader | null> {
  try {
    const firstLine = await readFirstLineAsync(filePath);
    if (firstLine && firstLine.trim()) {
      const header = JSON.parse(firstLine);
      if (header.type === "session") {
        return header as SessionHeader;
      }
    }
  } catch (err) {
    console.error("Failed to read header asynchronously:", err);
  }
  return null;
}

export function getSessionName(entries: SessionEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === "session_info") {
      return (entries[i] as { name?: string }).name;
    }
  }
  return undefined;
}



