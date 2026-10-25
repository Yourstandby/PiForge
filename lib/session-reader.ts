import { getAgentDir, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { getAgentHostClient } from "./agent-host-client.ts";
import type { SessionEntry, SessionInfo, SessionContext, SessionTreeNode, AgentMessage, SessionHeader } from "./types.ts";
import type { SessionEntry as PiSessionEntry } from "@earendil-works/pi-coding-agent";
import { normalizeToolCalls } from "./normalize.ts";
import { JSONL_WORKER_THRESHOLD_BYTES, parseJsonlFileInWorker } from "./jsonl-worker.ts";
import { scanSessionDirInWorker } from "./session-scan-worker.ts";
import { readFile, readdir, stat } from "fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
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

/** 数一个会话文件里用户真正发出去的消息条数。 */
/** 单文件用户消息计数（保留给外部调用；列表分页不再使用）。 */
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

// ---------------------------------------------------------------------------
// 会话索引（目录扫描结果，只 readdir + stat，不读文件内容）
//
// 旧实现走 SessionManager.listAll()：把每个 jsonl 全量流式解析一遍，再为「对话
// 次数」二次扫描全部文件。历史一多，首屏就是几百次全文件读 —— 启动卡顿的主因。
// 现在只索引路径 + mtime 排序，内容（name / firstMessage / 用户消息数）只为
// 当前分页窗口内的文件读取。
// ---------------------------------------------------------------------------
export interface SessionFileRef {
  path: string;
  mtimeMs: number;
  size: number;
}

interface SessionIndexState {
  files: SessionFileRef[] | null;
  at: number;
  inflight: Promise<SessionFileRef[]> | null;
}

const INDEX_TTL_MS = 10_000;
const INDEX_SCAN_CONCURRENCY = 8;
const INFO_READ_CONCURRENCY = 4;
const INFO_CACHE_LIMIT = 400;
/** 侧栏首屏一次加载的会话数；后续按批追加（见 SESSION_PAGE_STEP）。 */
export const SESSION_PAGE_SIZE = 20;
export const SESSION_PAGE_STEP = 10;

declare global {
  var __piforgeSessionIndexState: SessionIndexState | undefined;
  var __piforgeSessionInfoCache: Map<string, InfoCacheEntry> | undefined;
}

function getIndexState(): SessionIndexState {
  if (!globalThis.__piforgeSessionIndexState) {
    globalThis.__piforgeSessionIndexState = { files: null, at: 0, inflight: null };
  }
  return globalThis.__piforgeSessionIndexState;
}

/** 改名 / 删除 / 派生 / 新建会话后调用，避免 10s 内看到旧列表。 */
export function invalidateSessionIndex(): void {
  const state = getIndexState();
  state.files = null;
  state.at = 0;
}

async function scanSessionFiles(): Promise<SessionFileRef[]> {
  const root = getSessionsDir();
  // 全量 readdir + stat 放 worker 里跑：侧栏刷新时主线程 Event Loop 不能有尖峰。
  const offThread = await scanSessionDirInWorker(root).catch(() => null);
  if (offThread) return offThread;
  return scanSessionFilesInline(root);
}

/** worker 不可用时的兜底路径（逻辑与 worker 内保持一致）。 */
async function scanSessionFilesInline(root: string): Promise<SessionFileRef[]> {
  let dirs: string[] = [];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    dirs = entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => join(root, entry.name));
  } catch {
    return []; // 目录还不存在：没有任何会话
  }

  const nested = await mapWithLimit(dirs, INDEX_SCAN_CONCURRENCY, async (dir) => {
    try {
      const names = await readdir(dir);
      return names.filter((name) => name.endsWith(".jsonl")).map((name) => join(dir, name));
    } catch {
      return [];
    }
  });

  const candidates = nested.flat();
  const files = await mapWithLimit(candidates, INDEX_SCAN_CONCURRENCY * 2, async (path) => {
    try {
      const st = await stat(path);
      return { path, mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      return null;
    }
  });

  return files
    .filter((file): file is SessionFileRef => file !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path));
}

/** 目录索引（最近修改优先）。并发调用共享同一次扫描。 */
export async function getSessionIndex(options?: { force?: boolean }): Promise<SessionFileRef[]> {
  const state = getIndexState();
  if (!options?.force && state.files && Date.now() - state.at < INDEX_TTL_MS) return state.files;
  if (state.inflight) return state.inflight;
  const scan = scanSessionFiles()
    .then((files) => {
      state.files = files;
      state.at = Date.now();
      return files;
    })
    .finally(() => {
      if (state.inflight === scan) state.inflight = null;
    });
  state.inflight = scan;
  return scan;
}

/**
 * 后台临时会话（spawn_agent / 探针用的 `%TEMP%/piforge-probe…` 之类）会随任务
 * 创建、删除；它们一旦混进会话列表，侧栏就会多出一个「项目」再消失，看起来
 * 像列表在跳。这些不是用户的真实会话，直接不进列表。
 */
export function isScratchSessionCwd(cwd: string | undefined | null): boolean {
  if (!cwd) return false;
  const normalized = cwd.replace(/\\/g, "/").toLowerCase();
  const temp = tmpdir().replace(/\\/g, "/").toLowerCase().replace(/\/$/, "");
  if (!temp) return false;
  return (
    normalized === temp ||
    normalized.startsWith(`${temp}/`) ||
    normalized.includes("/piforge-probe")
  );
}

/** 会话文件名是 `<timestamp>_<sessionId>.jsonl`，id 直接从文件名取，不用读内容。 */
export function sessionIdFromPath(filePath: string): string {
  const name = basename(filePath).replace(/\.jsonl$/, "");
  const cut = name.lastIndexOf("_");
  return cut >= 0 ? name.slice(cut + 1) : name;
}

interface InfoCacheEntry {
  mtimeMs: number;
  size: number;
  info: SessionInfo | null;
}

function getInfoCache(): Map<string, InfoCacheEntry> {
  if (!globalThis.__piforgeSessionInfoCache) globalThis.__piforgeSessionInfoCache = new Map();
  return globalThis.__piforgeSessionInfoCache;
}

function extractMessageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as { type?: string; text?: unknown };
    if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
  }
  return parts.join(" ");
}

/** 读一个会话文件，产出侧栏需要的元数据（name / 首条用户消息 / 对话次数）。 */
interface SessionHeaderLite {
  id?: string;
  cwd?: string;
  timestamp?: string;
  parentSession?: string;
}

async function readSessionInfoFromDisk(ref: SessionFileRef): Promise<SessionInfo | null> {
  let header: SessionHeaderLite | null = null;
  let name: string | undefined;
  let firstMessage = "";
  let userMessageCount = 0;
  let leafEntryId: string | undefined;

  const stream = createReadStream(ref.path, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      if (!line.trim()) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // 半写入的最后一行：跳过
      }
      if (!header) {
        if (entry.type !== "session") return null;
        header = entry as SessionHeaderLite;
        continue;
      }
      if (typeof entry.id === "string") leafEntryId = entry.id;
      if (entry.type === "session_info") {
        const raw = typeof entry.name === "string" ? entry.name.trim() : "";
        name = raw || undefined;
      }
      if (entry.type === "message") {
        const message = entry.message as { role?: string } | undefined;
        if (message?.role === "user") {
          userMessageCount += 1;
          if (!firstMessage) firstMessage = extractMessageText(message).trim();
        }
      }
    }
  } catch {
    return null;
  } finally {
    reader.close();
    stream.destroy();
  }

  if (!header || typeof header.id !== "string") return null;
  const info: SessionInfo = {
    path: ref.path,
    id: header.id,
    cwd: typeof header.cwd === "string" ? header.cwd : "",
    name,
    created: typeof header.timestamp === "string" ? header.timestamp : new Date(ref.mtimeMs).toISOString(),
    modified: new Date(ref.mtimeMs).toISOString(),
    messageCount: userMessageCount,
    firstMessage: firstMessage || "(no messages)",
    parentSessionId: typeof header.parentSession === "string" ? sessionIdFromPath(header.parentSession) : undefined,
    leafEntryId,
  };
  return info;
}

async function readSessionInfoCached(ref: SessionFileRef): Promise<SessionInfo | null> {
  const cache = getInfoCache();
  const hit = cache.get(ref.path);
  if (hit && hit.mtimeMs === ref.mtimeMs && hit.size === ref.size) return hit.info;
  const info = await readSessionInfoFromDisk(ref);
  // 半写入 / 暂时读不出来时沿用上一次的元数据：否则该会话会从列表里闪一下再
  // 回来，侧栏里只属于它的项目分组就跟着「出现 → 消失」。
  const stable = info ?? hit?.info ?? null;
  cache.set(ref.path, { mtimeMs: ref.mtimeMs, size: ref.size, info: stable });
  if (cache.size > INFO_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return stable;
}

export interface SessionListPage {
  sessions: SessionInfo[];
  total: number;
  hasMore: boolean;
  /** 下一页的 offset 游标（= 已交付的文件窗口末端），前端追加时用它而不是列表长度。 */
  nextOffset: number;
}

/**
 * 首屏「每个项目至少一条」的补齐。
 *
 * 索引把全部项目的会话按 mtime 混排，最近几十条往往全属于同一个项目：只返回窗口
 * 的话，其余项目分组会整块不出现，看起来就像「升级后历史项目全没了」。这里给每个
 * 会话目录补上它自己最新的一条（只读这一条的 header），保证分组齐全；其余会话仍由
 * 滚动分页补充。
 */
async function latestPerProject(files: SessionFileRef[], knownPaths: Set<string>): Promise<SessionInfo[]> {
  const newestByDir = new Map<string, SessionFileRef>();
  for (const file of files) {
    const dir = dirname(file.path);
    if (!newestByDir.has(dir)) newestByDir.set(dir, file);
  }
  const picked = [...newestByDir.values()].filter((file) => !knownPaths.has(file.path));
  if (picked.length === 0) return [];
  const infos = await mapWithLimit(picked, INFO_READ_CONCURRENCY, (file) =>
    readSessionInfoCached(file).catch(() => null),
  );
  return infos.filter((info): info is SessionInfo => info !== null && !isScratchSessionCwd(info.cwd));
}

/**
 * 分页列出会话（最近修改在前）。只读当前窗口内的 jsonl，其余只 stat。
 * `keep` 用于深链/恢复：命中的会话即使不在窗口内也补进本页。
 */
export async function listSessionsPage(options?: {
  limit?: number;
  offset?: number;
  keep?: string | null;
}): Promise<SessionListPage> {
  const limit = Math.min(Math.max(1, Math.trunc(options?.limit ?? SESSION_PAGE_SIZE)), 200);
  const offset = Math.max(0, Math.trunc(options?.offset ?? 0));
  const files = await getSessionIndex();
  const window = files.slice(offset, offset + limit);
  const infos = await mapWithLimit(window, INFO_READ_CONCURRENCY, (file) =>
    readSessionInfoCached(file).catch(() => null),
  );
  let sessions = infos.filter(
    (info): info is SessionInfo => info !== null && !isScratchSessionCwd(info.cwd),
  );
  const cursor = offset + window.length;

  if (offset === 0) {
    const extra = await latestPerProject(files, new Set(sessions.map((session) => session.path)));
    if (extra.length > 0) {
      sessions = [...sessions, ...extra].sort((a, b) => b.modified.localeCompare(a.modified));
    }
  }

  const keep = options?.keep ?? null;
  if (keep && !sessions.some((session) => session.id === keep)) {
    const extra = files.find((file) => sessionIdFromPath(file.path) === keep);
    if (extra) {
      const info = await readSessionInfoCached(extra).catch(() => null);
      if (info) sessions.push(info);
    }
  }

  // 打开会话只需 id → 路径，这里顺手把本页写进路径缓存。
  for (const session of sessions) cacheSessionPath(session.id, session.path);

  return { sessions, total: files.length, hasMore: cursor < files.length, nextOffset: cursor };
}

/** 只认索引里的文件名，不读内容（用于 resolveSessionPath 的兜底）。 */
export async function locateSessionPathInIndex(sessionId: string): Promise<string | null> {
  const files = await getSessionIndex();
  return files.find((file) => sessionIdFromPath(file.path) === sessionId)?.path ?? null;
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

  // Cache miss: consult the directory index (readdir + stat only). A failing
  // scan (unreadable sessions dir, host restarting) must fall through to the
  // host lookup instead of bubbling up as a 500.
  const indexed = await locateSessionPathInIndex(sessionId).catch(() => null);
  if (indexed) {
    state.misses.delete(sessionId);
    cacheSessionPathEntry(state, sessionId, indexed);
    return indexed;
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

/**
 * 沿 leaf 的 parentId 链回到根。
 *
 * 与上游 `buildSessionPath()` 等价，唯一区别是**上游不导出**这个函数，而我们需要
 * 它在 compaction 之前的完整链路（`buildContextEntries()` 会把 firstKeptEntryId
 * 之前的所有条目丢掉）。
 */
function buildEntryPath(
  entries: PiSessionEntry[],
  leafId: string | null | undefined,
  byId: Map<string, PiSessionEntry>,
): PiSessionEntry[] {
  if (leafId === null) return [];
  const leaf = (leafId ? byId.get(leafId) : undefined) ?? entries[entries.length - 1];
  if (!leaf) return [];
  const path: PiSessionEntry[] = [];
  let current: PiSessionEntry | undefined = leaf;
  while (current) {
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path.reverse();
}

/**
 * 会话 → 界面可浏览的完整对话记录（**不折叠 compaction**）。
 *
 * 之前这里走 `buildSessionProjection()`，那是**给模型看的**投影：它只保留最新一个
 * compaction 之后的条目，更早的消息全部替换成一条摘要。后果是长会话重新打开后，
 * 压缩之前的历史在界面里彻底消失（对话导航的 items 也来自这份数据，所以刻度只剩
 * 压缩后的几轮）。
 *
 * 现在改为沿 parentId 链取全量，compaction 只留一条 `custom` 标记消息：
 * - 早期消息照常渲染、照常进导航；
 * - 标记是 `custom` 而不是 `user`，不会占掉一个「用户提问」刻度；
 * - `entryIds` 与 `messages` 依旧一一对应（Fork / 回溯依赖这条对齐）。
 *
 * context_edit（Pi 0.87+）语义保持不变：`replacement: null` 仍然移除该条贡献。
 */
export function buildSessionContext(entries: SessionEntry[], leafId?: string | null): SessionContext {
  const piEntries = entries as unknown as PiSessionEntry[];
  const byId = new Map(piEntries.map((entry) => [entry.id, entry]));
  const path = buildEntryPath(piEntries, leafId, byId);

  const edits = new Map<string, PiSessionEntry>();
  for (const entry of path) {
    if (entry.type === "context_edit") {
      edits.set((entry as unknown as { targetId: string }).targetId, entry);
    }
  }

  let thinkingLevel = "off";
  let model: SessionContext["model"] = null;
  for (const entry of path) {
    if (entry.type === "thinking_level_change") {
      thinkingLevel = (entry as unknown as { thinkingLevel: string }).thinkingLevel;
    } else if (entry.type === "model_change") {
      const change = entry as unknown as { provider: string; modelId: string };
      model = { provider: change.provider, modelId: change.modelId };
    }
  }

  const messages: AgentMessage[] = [];
  const entryIds: string[] = [];
  /* 最新一个压缩点之前的消息是本次新增的展示内容。它们的工具输出/思考往往占掉了
     整个会话体积的 90%（实测同一会话从 1.1MB 到 25MB），不截会直接拖垮打开速度；
     截断的只是**压缩前**那一段，压缩后的部分与以前一模一样。 */
  const newestCompactionAt = path.reduce((last, entry, index) => (entry.type === "compaction" ? index : last), -1);

  for (const [index, entry] of path.entries()) {
    if (entry.type === "branch_summary") {
      const branchSummary = entry as unknown as { summary?: string; fromId?: string };
      // 蒸馏出来的分支摘要：只存在于这条路径上，模型侧当上下文，界面里当一张提示卡。
      const marker = {
        role: "custom" as const,
        customType: "piforge/branch-summary",
        display: true,
        content: [
          {
            type: "text" as const,
            text: `> 分支蒸馏：下面这段是把被放弃的分支合并进来的结论（原始消息仍在分支树上，可随时切回去看）。\n\n${branchSummary.summary ?? ""}`,
          },
        ],
        details: { fromId: branchSummary.fromId },
        timestamp: entry.timestamp ? new Date(entry.timestamp).getTime() : undefined,
      };
      messages.push(marker as unknown as AgentMessage);
      entryIds.push(entry.id);
      continue;
    }

    if (entry.type === "compaction") {
      const compaction = entry as unknown as { summary?: string; tokensBefore?: number };
      // 显示成 custom 而不是 user：模型侧才是真压缩，界面里历史仍然完整。
      const marker = {
        role: "custom" as const,
        customType: "piforge/compaction",
        display: true,
        content: [
          {
            type: "text" as const,
            text: `> 上下文压缩点：此前的对话已折叠为下面这段摘要（只影响模型请求，上方历史仍按原样保留）。\n\n${compaction.summary ?? ""}`,
          },
        ],
        details: { tokensBefore: compaction.tokensBefore },
        timestamp: entry.timestamp ? new Date(entry.timestamp).getTime() : undefined,
      };
      messages.push(marker as unknown as AgentMessage);
      entryIds.push(entry.id);
      continue;
    }

    const edit = edits.get(entry.id);
    const projected = projectDisplayEntry(entry, edit);
    const beforeCompaction = newestCompactionAt >= 0 && index < newestCompactionAt;
    for (const message of projected) {
      const normalized = normalizeToolCalls(message);
      messages.push(beforeCompaction ? elideHeavyHistory(normalized) : normalized);
      entryIds.push(entry.id);
    }
  }

  return { messages, entryIds, thinkingLevel, model };
}

/** 压缩前历史单块文本的保留长度；超出部分只留预览。 */
const HISTORY_BLOCK_PREVIEW = 1200;

/**
 * 压缩前历史的瘦身：把超长的文本 / 思考块截成预览、图片块换成占位。
 *
 * 只动「模型侧已经不再引用」的那一段：用户提问、回答正文都保留，长工具输出只留头部
 * 预览 + 省略说明（和置顶的 toolHistory 机制语义一致，都是“历史里不重复塞大段输出”）。
 * 图片必须单独处理 —— 实测一个 25MB 的会话里 23MB 是 29 张粘贴截图的 base64。
 */
function elideHeavyHistory(message: AgentMessage): AgentMessage {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return message;
  let changed = false;
  const next: unknown[] = [];
  for (const block of content) {
    const record = block as { type?: string; text?: unknown; thinking?: unknown };
    if (record?.type === "image") {
      changed = true;
      next.push({ type: "text", text: "〔压缩前历史中的图片已省略〕" });
      continue;
    }
    const field = record?.type === "text" ? "text" : record?.type === "thinking" ? "thinking" : null;
    const value = field ? record[field] : undefined;
    if (!field || typeof value !== "string" || value.length <= HISTORY_BLOCK_PREVIEW) {
      next.push(block);
      continue;
    }
    changed = true;
    next.push({
      ...record,
      [field]: `${value.slice(0, HISTORY_BLOCK_PREVIEW)}\n\n…（压缩前的历史已省略剩余 ${value.length - HISTORY_BLOCK_PREVIEW} 字符）`,
    });
  }
  return changed ? ({ ...message, content: next } as AgentMessage) : message;
}

/** 单条 entry → 消息数组，并套用 context_edit（与上游 projectContextEntry 同语义）。 */
function projectDisplayEntry(entry: PiSessionEntry, edit: PiSessionEntry | undefined): AgentMessage[] {
  const messages = sessionEntryToContextMessages(entry) as unknown as AgentMessage[];
  if (!edit) return messages;
  const replacement = (edit as unknown as { replacement: { content: unknown } | null }).replacement;
  if (replacement === null) return [];
  return messages.map((message) => {
    const raw = message as unknown as { role?: string };
    if (raw.role !== "user" && raw.role !== "assistant" && raw.role !== "toolResult" && raw.role !== "custom") {
      return message;
    }
    const content =
      (raw.role === "assistant" || raw.role === "toolResult") && typeof replacement.content === "string"
        ? [{ type: "text", text: replacement.content }]
        : replacement.content;
    return { ...message, content } as AgentMessage;
  });
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

  // > 1MB 的会话文件交给 worker 解析：split+JSON.parse 几万个条目会长时间占住
  // Event Loop（Electron 主进程里就是掉帧）。小文件走内联路径，省掉 worker 启动成本。
  let parsed: { entries: SessionEntry[]; malformed: number } | null = null;
  if (info && info.size > JSONL_WORKER_THRESHOLD_BYTES) {
    const fromWorker = await parseJsonlFileInWorker<SessionEntry>(filePath).catch(() => null);
    if (fromWorker) parsed = fromWorker;
  }

  if (!parsed) {
    const content = await readFile(filePath, "utf8");
    const lines = content.split("\n");
    const entries: SessionEntry[] = [];
    let malformed = 0;
    for (const line of lines) {
      if (line.trim()) {
        try {
          entries.push(JSON.parse(line) as SessionEntry);
        } catch {
          malformed += 1;
        }
      }
    }
    parsed = { entries, malformed };
  }
  const entries = parsed.entries;

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



