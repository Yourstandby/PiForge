import { SessionManager, buildSessionProjection, getAgentDir } from "@earendil-works/pi-coding-agent";
import { getAgentHostClient } from "./agent-host-client.ts";
import type { SessionEntry, SessionInfo, SessionContext, SessionTreeNode, AssistantMessage, SessionHeader } from "./types.ts";
import type { SessionEntry as PiSessionEntry, SessionInfo as PiSessionInfo } from "@earendil-works/pi-coding-agent";
import { normalizeToolCalls } from "./normalize.ts";
import { readFile, stat } from "fs/promises";
import { createReadStream } from "fs";
import { createInterface } from "node:readline";
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

// ---------------------------------------------------------------------------
// 会话「对话次数」= 用户消息条数（不是全部消息条数）
//
// pi 的 SessionInfo.messageCount 统计的是**所有** message 条目（user/assistant/
// toolResult…），长会话里动辄上千条，作为「对话次数」没有意义。这里按需再扫一遍
// jsonl，只数 role === "user" 的条目；结果按 (path, mtime, size) 缓存，命中时只
// 做一次 stat，列表刷新不会重复读大文件。
// ---------------------------------------------------------------------------
interface UserMessageCountCacheEntry {
  mtimeMs: number;
  size: number;
  count: number;
}

const USER_COUNT_CACHE_KEY = "__piforgeSessionUserCountCache";
/** 快速预筛：不匹配的行直接跳过 JSON.parse。 */
const ROLE_USER_RE = /"role"\s*:\s*"user"/;

function getUserCountCache(): Map<string, UserMessageCountCacheEntry> {
  const holder = globalThis as unknown as Record<string, Map<string, UserMessageCountCacheEntry> | undefined>;
  if (!holder[USER_COUNT_CACHE_KEY]) holder[USER_COUNT_CACHE_KEY] = new Map();
  return holder[USER_COUNT_CACHE_KEY]!;
}

const USER_COUNT_CACHE_LIMIT = 500;
const USER_COUNT_CONCURRENCY = 32;

/** 数一个会话文件里用户真正发出去的消息条数。 */
export async function countUserMessages(filePath: string): Promise<number> {
  const cache = getUserCountCache();
  let info: { mtimeMs: number; size: number };
  try {
    const st = await stat(filePath);
    info = { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return 0;
  }

  const cached = cache.get(filePath);
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
    return cached.count;
  }

  let count = 0;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    try {
      const stream = createReadStream(filePath, { encoding: "utf8" });
      const reader = createInterface({ input: stream, crlfDelay: Infinity });
      reader.on("line", (line) => {
        if (!line || !ROLE_USER_RE.test(line)) return;
        try {
          const entry = JSON.parse(line) as { type?: string; message?: { role?: string } };
          if (entry?.type === "message" && entry.message?.role === "user") count += 1;
        } catch {
          // 半行 / 损坏行直接跳过，不让单行毁掉整个计数
        }
      });
      reader.on("close", finish);
      reader.on("error", finish);
      stream.on("error", finish);
    } catch {
      finish();
    }
  });

  cache.set(filePath, { ...info, count });
  if (cache.size > USER_COUNT_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return count;
}

/** 限制并发地跑一个异步映射，避免几百个会话同时开文件流。 */
async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function listAllSessions(): Promise<SessionInfo[]> {
  const piSessions: PiSessionInfo[] = await SessionManager.listAll();
  const pathToId = new Map<string, string>();
  for (const s of piSessions) pathToId.set(s.path, s.id);

  // 对话次数 = 用户消息条数（失败时回落 0，不影响列表展示）
  const userMessageCounts = await mapWithLimit(piSessions, USER_COUNT_CONCURRENCY, (s) =>
    countUserMessages(s.path).catch(() => 0),
  );

  const state = getPathCacheState();
  return piSessions.map((s, index) => {
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
      messageCount: userMessageCounts[index] ?? 0,
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

  // Cache miss: scan all sessions to populate cache, then retry. A failing
  // scan (unreadable sessions dir, host restarting) must fall through to the
  // host lookup instead of bubbling up as a 500.
  await listAllSessions().catch(() => undefined);
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
  const cache = getEntriesCache();
  let info: { mtimeMs: number; size: number } | null = null;
  try {
    const st = await stat(filePath);
    info = { mtimeMs: st.mtimeMs, size: st.size };
    const hit = cache.get(filePath);
    // 同一文件未变更时直接复用解析结果：重复打开历史会话不再重新 read+parse 整个 JSONL。
    if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) return hit.entries;
  } catch {
    // 读不到 stat（文件刚被删/权限）就退回无缓存路径，保持原有容错。
  }

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

  if (info) {
    cache.set(filePath, { ...info, entries });
    if (cache.size > ENTRIES_CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }
  return entries;
}

interface EntriesCacheEntry {
  mtimeMs: number;
  size: number;
  entries: SessionEntry[];
}

const ENTRIES_CACHE_KEY = "__piforgeSessionEntriesCache";
const ENTRIES_CACHE_LIMIT = 24;

function getEntriesCache(): Map<string, EntriesCacheEntry> {
  const holder = globalThis as unknown as Record<string, Map<string, EntriesCacheEntry> | undefined>;
  if (!holder[ENTRIES_CACHE_KEY]) holder[ENTRIES_CACHE_KEY] = new Map();
  return holder[ENTRIES_CACHE_KEY]!;
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



