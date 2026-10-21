"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface UseChatScrollOptions {
  messageCount: number;
  agentRunning: boolean;
  streamingMessage?: unknown;
  /** 当前标签页是否可见：用于记忆/恢复滚动位置。 */
  active?: boolean;
}

export function useChatScroll({
  messageCount,
  agentRunning,
  streamingMessage,
  active = true,
}: UseChatScrollOptions) {
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [containerNode, setContainerNode] = useState<HTMLDivElement | null>(null);
  const pendingScrollToUserRef = useRef(false);
  const initialScrollDoneRef = useRef(false);
  const isAtBottomRef = useRef(true);
  /** 标签页切换记忆：是否曾可见、离开时的滚动位置、离开时是否贴底。 */
  const visitedRef = useRef(false);
  const savedTopRef = useRef<number | null>(null);
  const savedAtBottomRef = useRef(true);

  const setScrollContainer = useCallback((node: HTMLDivElement | null) => {
    scrollContainerRef.current = node;
    setContainerNode(node);
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    messagesEndRef.current?.scrollIntoView({ behavior });
  }, []);

  const handleScroll = useCallback(() => {
    const container = containerNode;
    if (!container) return;
    const distanceToBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    // Consider user at bottom if within 80px of bottom
    isAtBottomRef.current = distanceToBottom < 80;
    // 持续记录当前位置：切标签时无需再读 display:none 容器的 scrollTop。
    savedTopRef.current = container.scrollTop;
  }, [containerNode]);

  // Track user scroll position on the active container node
  useEffect(() => {
    if (!containerNode) return;
    handleScroll();
    containerNode.addEventListener("scroll", handleScroll, { passive: true });
    return () => containerNode.removeEventListener("scroll", handleScroll);
  }, [containerNode, handleScroll]);

  // Initial load scroll to bottom once container mounts. 必须在 active 为真
  // 时才执行：标签隐藏（display:none）期间 scrollIntoView 是无效的。
  // 历史会话常带图片/代码块，首屏渲染后还会异步擑高，所以首次贴底要补几次，
  // 否则会停在中间（看起来“没到最新处”）。
  useEffect(() => {
    if (messageCount <= 0 || !containerNode || !active) return;
    if (initialScrollDoneRef.current) return;
    initialScrollDoneRef.current = true;
    isAtBottomRef.current = true;
    const stick = () => {
      if (!isAtBottomRef.current) return;
      scrollToBottom("auto");
    };
    scrollToBottom("auto");
    requestAnimationFrame(stick);
    const t1 = window.setTimeout(stick, 200);
    const t2 = window.setTimeout(stick, 700);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [messageCount, containerNode, scrollToBottom, active]);

  // 标签页切换：离开时记住滚动位置，回来时恢复；离开时在底部则继续贴底。
  // 恢复分几帧重复写入：图片/代码块会在切回后异步擑高，一次恢复会被
  // 强制 clamp 到中间（“乱跳到中间”）。
  useEffect(() => {
    const container = containerNode;
    if (!container) return;
    if (!active) {
      savedTopRef.current = container.scrollTop;
      savedAtBottomRef.current = isAtBottomRef.current;
      return;
    }
    if (!visitedRef.current) {
      visitedRef.current = true;
      return;
    }
    const atBottom = savedAtBottomRef.current;
    const top = savedTopRef.current;
    isAtBottomRef.current = atBottom;
    const restore = () => {
      if (atBottom) {
        container.scrollTop = container.scrollHeight;
      } else if (top != null) {
        container.scrollTop = top;
      }
    };
    restore();
    requestAnimationFrame(restore);
    const t1 = window.setTimeout(restore, 120);
    const t2 = window.setTimeout(restore, 400);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [active, containerNode]);

  // When user sends a message, scroll down and lock to bottom
  useEffect(() => {
    if (pendingScrollToUserRef.current) {
      pendingScrollToUserRef.current = false;
      initialScrollDoneRef.current = true;
      isAtBottomRef.current = true;
      scrollToBottom("smooth");
    }
  }, [messageCount, scrollToBottom]);

  // During streaming/thinking/tool execution, auto-scroll to bottom if user is at bottom
  useEffect(() => {
    if (agentRunning && isAtBottomRef.current) {
      scrollToBottom("auto");
    }
  }, [streamingMessage, messageCount, agentRunning, scrollToBottom]);

  // When the agent settles or the transcript changes while at the bottom,
  // smoothly follow the new context without interrupting manual history review.
  useEffect(() => {
    if (!agentRunning && initialScrollDoneRef.current && isAtBottomRef.current) {
      scrollToBottom("smooth");
    }
  }, [agentRunning, messageCount, scrollToBottom]);

  return {
    messagesEndRef,
    scrollContainerRef,
    setScrollContainer,
    pendingScrollToUserRef,
    initialScrollDoneRef,
    scrollToBottom,
  };
}
