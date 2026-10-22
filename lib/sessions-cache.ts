"use client";

/**
 * 会话列表的共享客户端缓存（分页）。
 *
 * `/api/sessions` 现在是分页接口：首屏 20 个会话，历史会话在侧栏滚动时才按批
 * （每批 10 个）追加。这里按 offset 缓存每页结果并去重并发请求，避免 Workbench
 * 与 SessionSidebar 各拉一次、也避免滚动回顶部时重新请求。
 *
 * 深链/恢复（`?session=<id>`）用 `keep` 参数保证目标会话一定在第一页里返回，
 * 这样不在最近 20 个之内的会话也能直接打开。
 */
import type { SessionInfo } from "@/lib/types";

const TTL_MS = 3000;
export const SESSION_PAGE_SIZE = 20;
export const SESSION_PAGE_STEP = 10;

export interface SessionPage {
  sessions: SessionInfo[];
  total: number;
  hasMore: boolean;
}

interface PageEntry {
  page: SessionPage;
  at: number;
}

interface CacheState {
  pages: Map<number, PageEntry>;
  inflight: Map<number, Promise<SessionPage>>;
}

const store = globalThis as typeof globalThis & {
  __piforgeSessionsClientCache?: CacheState;
};
if (!store.__piforgeSessionsClientCache) {
  store.__piforgeSessionsClientCache = { pages: new Map(), inflight: new Map() };
}
const cache = store.__piforgeSessionsClientCache!;

/** 深链会话 id：拿到就带上，服务端会把它补进第一页。 */
function keepSessionId(): string | null {
  try {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("session");
  } catch {
    return null;
  }
}

async function request(offset: number, limit: number): Promise<SessionPage> {
  const params = new URLSearchParams({ offset: String(offset), limit: String(limit) });
  const keep = keepSessionId();
  if (keep) params.set("keep", keep);
  const response = await fetch(`/api/sessions?${params.toString()}`);
  if (!response.ok) throw new Error(`/api/sessions ${response.status}`);
  const data = (await response.json()) as Partial<SessionPage> & { sessions?: SessionInfo[] };
  const sessions = data.sessions ?? [];
  return {
    sessions,
    total: typeof data.total === "number" ? data.total : offset + sessions.length,
    hasMore: typeof data.hasMore === "boolean" ? data.hasMore : false,
  };
}

export function fetchSessionPage(
  offset = 0,
  limit = SESSION_PAGE_SIZE,
  options?: { force?: boolean },
): Promise<SessionPage> {
  const force = options?.force ?? false;
  const now = Date.now();
  const cached = cache.pages.get(offset);
  if (!force && cached && now - cached.at < TTL_MS) return Promise.resolve(cached.page);
  if (!force) {
    const inflight = cache.inflight.get(offset);
    if (inflight) return inflight;
  }

  const promise = request(offset, limit)
    .then((page) => {
      cache.pages.set(offset, { page, at: Date.now() });
      return page;
    })
    .finally(() => {
      if (cache.inflight.get(offset) === promise) cache.inflight.delete(offset);
    });
  cache.inflight.set(offset, promise);
  return promise;
}

/**
 * 取「至少 count 个」会话，用于刷新时保住已经滚动加载出来的深度。
 *
 * 只写不走分页缓存（缓存键是 offset），避免把大页塞进第一页缓存里影响后续
 * `offset=20` 的追加请求。
 */
export async function fetchSessionsUpTo(count: number): Promise<SessionPage | null> {
  const limit = Math.min(200, Math.max(SESSION_PAGE_SIZE, count));
  try {
    return await request(0, limit);
  } catch {
    return null;
  }
}

/** 首屏列表（兼容旧调用点）：等于第一页的会话数组。 */
export async function fetchSessions(options?: { force?: boolean }): Promise<SessionInfo[]> {
  const page = await fetchSessionPage(0, SESSION_PAGE_SIZE, options);
  return page.sessions;
}

export function invalidateSessions(): void {
  cache.pages.clear();
  cache.inflight.clear();
}

/** 测试用：清空缓存状态。 */
export function resetSessionsCacheForTests(): void {
  invalidateSessions();
}
