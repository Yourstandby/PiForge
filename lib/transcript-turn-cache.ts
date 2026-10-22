/**
 * 轮次对象的身份缓存（渲染性能的关键一环）。
 *
 * 背景：`messages` 每帧都会变（流式追加一条），但**历史消息对象引用不变**。
 * `buildTranscriptTurns` 如果每帧重建每一轮的对象，`TurnRow` 的 `memo` 比较
 * `prev.turn !== next.turn` 必然不等 → 20 轮会话在流式期间每帧全量重渲
 * （开发日志里的 `turn 173 rendered 777 times` 就是这么来的）。
 *
 * 命中条件 = 消息对象同一 **且** 它引用的工具结果对象也同一；
 * 工具结果回填时该轮会重建，所以不会漏更新。
 */
export interface TurnCacheEntry<T> {
  refs: readonly unknown[];
  turn: T | null;
}

export interface TurnCacheOptions<M, T> {
  /** 消息里参与渲染的外部引用（如 toolCall 对应的 toolResult 对象）。 */
  refsOf: (message: M) => readonly unknown[];
  /** 真正构建一轮视图（只在缓存未命中时调用）。 */
  build: (message: M, index: number) => T | null;
  /** 消息下标变了但内容没变时，如何把它带到新下标（默认浅拷贝并改写 index）。 */
  reindex?: (turn: T, index: number) => T;
}

/** 进程内单例缓存（HMR 安全）；WeakMap 保证消息被回收时不泄漏。 */
export function createTurnCacheStore<M extends object, T>(): WeakMap<M, TurnCacheEntry<T>> {
  return new WeakMap();
}

export function buildWithTurnCache<M extends object, T extends { messageIndex: number }>(
  messages: readonly M[],
  cache: WeakMap<M, TurnCacheEntry<T>>,
  options: TurnCacheOptions<M, T>,
): (T | null)[] {
  return messages.map((message, index): T | null => {
    const refs = options.refsOf(message);
    const cached = cache.get(message);
    if (cached && refsEqual(cached.refs, refs)) {
      if (!cached.turn) return null;
      if (cached.turn.messageIndex === index) return cached.turn;
      return options.reindex ? options.reindex(cached.turn, index) : { ...cached.turn, messageIndex: index };
    }
    const built = options.build(message, index);
    cache.set(message, { refs, turn: built });
    return built;
  });
}

function refsEqual(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}
