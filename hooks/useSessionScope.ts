"use client";

/**
 * 会话切换时的资源清理（第二部分 · 彻底清理）。
 *
 * `useSessionScope(sessionId)`：
 *   - 拿到会话作用域里的定时器/观察者工厂；
 *   - 会话 id 变化时，先把**上一个会话**登记的定时器与观察者一次性释放，
 *     再开始登记新的 —— 上一个会话的 `setInterval` / `ResizeObserver`
 *     绝不可能在切换后继续回调。
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { sessionScope } from "@/lib/session-scope";

export interface ScopedTimers {
  /** 返回幂等的取消函数（会话切换时作用域也会再释放一次）。 */
  setTimeout: (run: () => void, ms: number) => () => void;
  setInterval: (run: () => void, ms: number) => () => void;
  /** 登记任意释放函数（ResizeObserver / IntersectionObserver / 监听器）。 */
  track: (dispose: () => void) => void;
}

export function useSessionScope(sessionId: string | null | undefined): ScopedTimers {
  const previousRef = useRef<string | null | undefined>(sessionId);

  useEffect(() => {
    const previous = previousRef.current;
    if (previous && previous !== sessionId) sessionScope.disposeSession(previous);
    previousRef.current = sessionId;
  }, [sessionId]);

  // 组件真正卸载时（标签关闭）也要把自己登记的东西收干净。
  useEffect(() => {
    const id = sessionId;
    return () => {
      if (id) sessionScope.disposeSession(id);
    };
  }, [sessionId]);

  const track = useCallback(
    (dispose: () => void) => {
      sessionScope.track(sessionId, dispose);
    },
    [sessionId],
  );

  return useMemo(
    () => ({
      setTimeout: (run, ms) => sessionScope.setTimeout(sessionId, run, ms),
      setInterval: (run, ms) => sessionScope.setInterval(sessionId, run, ms),
      track,
    }),
    [sessionId, track],
  );
}
