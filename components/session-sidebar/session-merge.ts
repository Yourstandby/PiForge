import type { SessionInfo } from "../../lib/types.ts";

/**
 * 刷新会话列表时保持行对象稳定。
 *
 * 以前每次刷新都 `setAllSessions(新的全量数组)`：即使内容一字未变，所有行都是
 * 新对象 → 行组件全部重渲染、滚动与悬停状态被打断，视觉上就是"左侧栏一直在
 * 刷新/跳动"。
 *
 * 规则：
 * - 内容未变的会话复用旧对象（引用相等 → 下游 memo / 行组件直接跳过重渲染）；
 * - 旧会话保持旧顺序，只有全新会话按服务端顺序插到最前面（新会话本来就是最新的）；
 * - 服务端不再返回的会话（已删除）从结果里去掉。
 */
export function mergeSessionList(
  previous: readonly SessionInfo[],
  next: readonly SessionInfo[],
): SessionInfo[] {
  if (previous.length === 0) return [...next];
  const nextById = new Map(next.map((session) => [session.id, session]));
  const kept: SessionInfo[] = [];
  for (const old of previous) {
    const incoming = nextById.get(old.id);
    if (!incoming) continue;
    kept.push(sameSession(old, incoming) ? old : incoming);
  }
  if (kept.length === 0) return [...next];
  const seen = new Set(kept.map((session) => session.id));
  const fresh = next.filter((session) => !seen.has(session.id));
  return fresh.length > 0 ? [...fresh, ...kept] : kept;
}

function sameSession(a: SessionInfo, b: SessionInfo): boolean {
  const keys = Object.keys(b) as Array<keyof SessionInfo>;
  if (keys.length !== Object.keys(a).length) return false;
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}
