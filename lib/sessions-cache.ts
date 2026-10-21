"use client";

/**
 * 会话列表的共享客户端缓存。
 *
 * 首屏有两处会请求 `/api/sessions`（Workbench 决定打开哪个标签、
 * SessionSidebar 渲染列表），而该接口要扫描并统计磁盘上的每个会话文件。
 * 用一个模块级 promise 去重：并发的两处只发一次网络请求，3 秒内复用结果。
 */
import type { SessionInfo } from "@/lib/types";

const TTL_MS = 3000;

interface CacheState {
  data: SessionInfo[] | null;
  at: number;
  inflight: Promise<SessionInfo[]> | null;
}

const store = globalThis as typeof globalThis & {
  __piforgeSessionsClientCache?: CacheState;
};
if (!store.__piforgeSessionsClientCache) {
  store.__piforgeSessionsClientCache = { data: null, at: 0, inflight: null };
}
const cache = store.__piforgeSessionsClientCache!;

async function request(): Promise<SessionInfo[]> {
  const response = await fetch("/api/sessions");
  if (!response.ok) throw new Error(`/api/sessions ${response.status}`);
  const data = (await response.json()) as { sessions?: SessionInfo[] };
  return data.sessions ?? [];
}

export function fetchSessions(options?: { force?: boolean }): Promise<SessionInfo[]> {
  const force = options?.force ?? false;
  const now = Date.now();
  if (!force && cache.data && now - cache.at < TTL_MS) return Promise.resolve(cache.data);
  if (!force && cache.inflight) return cache.inflight;

  const promise = request()
    .then((sessions) => {
      cache.data = sessions;
      cache.at = Date.now();
      return sessions;
    })
    .finally(() => {
      if (cache.inflight === promise) cache.inflight = null;
    });
  cache.inflight = promise;
  return promise;
}

export function invalidateSessions(): void {
  cache.data = null;
  cache.at = 0;
  cache.inflight = null;
}

/** 测试用：清空缓存状态。 */
export function resetSessionsCacheForTests(): void {
  invalidateSessions();
}
