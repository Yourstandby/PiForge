/**
 * 流式增量「按帧合流」。
 *
 * SSE 每个 token 一个事件 → 每个事件一次 setState → 一次 React 渲染 + 一次滚动布局。
 * 60 tokens/s 就是 60 次渲染；一帧里往往挤进 2–4 个快照，肉眼完全看不出差别，
 * 但主线程被这些渲染吃满了。
 *
 * 这里只做一件事：**一帧最多提交最后一次快照**。纯逻辑 + 注入调度器，
 * 方便在 node 里单测（不需要真的 requestAnimationFrame）。
 */

export interface FrameScheduler {
  request(callback: () => void): number;
  cancel(handle: number): void;
}

export interface FrameCoalescer<T> {
  /** 记下最新值；同一帧内多次调用只保留最后一次。 */
  push(value: T): void;
  /** 立刻把待提交值交出去（切换 action 前必须调用，否则会丢最后一帧）。 */
  flush(): void;
  /** 有值待提交吗。 */
  get pending(): boolean;
  /** 卸载时丢弃待提交值。 */
  dispose(): void;
}

export const immediateScheduler: FrameScheduler = {
  request: (callback) => {
    callback();
    return 0;
  },
  cancel: () => {},
};

/** 浏览器默认调度器；node / jsdom 没有 rAF 时退化成同步提交。 */
export function defaultFrameScheduler(): FrameScheduler {
  if (typeof requestAnimationFrame === "function" && typeof cancelAnimationFrame === "function") {
    return {
      request: (callback) => requestAnimationFrame(callback),
      cancel: (handle) => cancelAnimationFrame(handle),
    };
  }
  return immediateScheduler;
}

export function createFrameCoalescer<T>(
  commit: (value: T) => void,
  scheduler: FrameScheduler = defaultFrameScheduler(),
): FrameCoalescer<T> {
  let latest: T | null = null;
  let hasValue = false;
  let handle: number | null = null;
  let disposed = false;

  const clearTimer = () => {
    if (handle === null) return;
    scheduler.cancel(handle);
    handle = null;
  };

  const flushNow = () => {
    clearTimer();
    if (!hasValue) return;
    const value = latest as T;
    latest = null;
    hasValue = false;
    if (!disposed) commit(value);
  };

  return {
    push(value: T) {
      if (disposed) return;
      latest = value;
      hasValue = true;
      // 已经排过这一帧了：只更新待提交值，不再排第二次。
      if (handle !== null) return;
      handle = scheduler.request(() => {
        handle = null;
        flushNow();
      });
    },
    flush() {
      flushNow();
    },
    get pending() {
      return hasValue;
    },
    dispose() {
      disposed = true;
      clearTimer();
      latest = null;
      hasValue = false;
    },
  };
}
