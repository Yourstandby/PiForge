"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * 当前会话 id 的静态上下文。
 *
 * 只放一个不变的字符串，不放看门狗快照 —— 快照由各叶子组件自己
 * `useSyncExternalStore` 订阅。这样每秒的轮询更新只影响真正用到它的
 * 那几个小组件，不会让整棵对话树（上千条消息）跟着重渲染。
 */
const WatchdogSessionContext = createContext<string | null>(null);

export function WatchdogSessionProvider({
  sessionId,
  children,
}: {
  sessionId: string | null;
  children: ReactNode;
}) {
  return <WatchdogSessionContext.Provider value={sessionId}>{children}</WatchdogSessionContext.Provider>;
}

export function useWatchdogSessionId(): string | null {
  return useContext(WatchdogSessionContext);
}
