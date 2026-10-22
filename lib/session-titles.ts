/**
 * 会话标题 / 归属的小缓存（进程内，HMR 安全）。
 *
 * 右栏 Agents 面板需要显示 `项目 › 会话标题`，但侧栏才是会话列表的加载者。
 * 为了不额外发一次 `/api/sessions`（那是全盘扫描，很贵），这里让侧栏在拿到
 * 列表时顺手登记一下；Agents 面板用 `useSyncExternalStore` 订阅这份快照。
 *
 * 只存 id → { title, cwd }，条目数由侧栏已加载的深度决定（默认 20 起，滚动加 10）。
 */

export interface SessionTitleEntry {
  title: string;
  cwd: string;
}

/** 最多保留多少条：够覆盖侧栏已加载的历史，不无限增长。 */
const MAX_ENTRIES = 400;

const store = globalThis as typeof globalThis & {
  __piforgeSessionTitles?: {
    map: Map<string, SessionTitleEntry>;
    version: number;
    listeners: Set<() => void>;
  };
};

if (!store.__piforgeSessionTitles) {
  store.__piforgeSessionTitles = { map: new Map(), version: 0, listeners: new Set() };
}
const state = store.__piforgeSessionTitles;

function emit(): void {
  state.version += 1;
  for (const listener of state.listeners) {
    try {
      listener();
    } catch {
      /* 订阅方异常不能影响其它订阅 */
    }
  }
}

function titleOf(session: { name?: string; firstMessage?: string }): string {
  const named = session.name?.trim();
  if (named) return named;
  const first = session.firstMessage?.replace(/\s+/g, " ").trim() ?? "";
  if (!first) return "";
  return first.length > 40 ? `${first.slice(0, 40)}…` : first;
}

/** 侧栏加载 / 刷新会话列表后调用（同值不触发重渲染）。 */
export function rememberSessionTitles(
  sessions: readonly { id: string; cwd?: string; name?: string; firstMessage?: string }[],
): void {
  let changed = false;
  for (const session of sessions) {
    const entry: SessionTitleEntry = { title: titleOf(session), cwd: session.cwd ?? "" };
    const previous = state.map.get(session.id);
    if (previous && previous.title === entry.title && previous.cwd === entry.cwd) continue;
    state.map.set(session.id, entry);
    changed = true;
  }
  if (state.map.size > MAX_ENTRIES) {
    // Map 迭代顺序 = 插入顺序，砍最老的。
    for (const key of [...state.map.keys()].slice(0, state.map.size - MAX_ENTRIES)) {
      state.map.delete(key);
    }
    changed = true;
  }
  if (changed) emit();
}

export function getSessionTitleEntry(sessionId: string): SessionTitleEntry | undefined {
  return state.map.get(sessionId);
}

export function sessionTitlesVersion(): number {
  return state.version;
}

export function subscribeSessionTitles(listener: () => void): () => void {
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}

/** 供 UI 一次性取快照（配合 useSyncExternalStore 的 getSnapshot）。 */
export function sessionTitleSnapshot(): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [id, entry] of state.map) {
    if (entry.title) out[id] = entry.title;
  }
  return out;
}
