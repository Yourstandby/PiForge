"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentMessage, SessionTreeNode } from "../../lib/types";
import type { SessionBranches } from "@contract/domains/sessions";
import type { FollowUpQueueSnapshot } from "../../lib/follow-up-queue";
import type { ContextBudget } from "../../lib/pi-types";
import type { SessionStats } from "./session-stats.ts";
import { fetchSession, fetchContext, fetchBranches } from "./session-loader-api.ts";

/** Latest-request-wins guard: stale() goes true once a newer call bumps the ref. */
export function latestRequestStale(ref: { current: number }): () => boolean {
  const reqId = ++ref.current;
  return () => reqId !== ref.current;
}

export interface SessionData {
  sessionId: string;
  filePath: string;
  tree: SessionTreeNode[];
  leafId: string | null;
  context: {
    messages: AgentMessage[];
    entryIds: string[];
    thinkingLevel: string;
    model: { provider: string; modelId: string } | null;
  };
}

export interface LoadedAgentState {
  running: boolean;
  state?: {
    isStreaming?: boolean;
    isCompacting?: boolean;
    contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null;
    contextBudget?: ContextBudget | null;
    sessionStats?: SessionStats | null;
    systemPrompt?: string;
    thinkingLevel?: string;
    followUpQueue?: FollowUpQueueSnapshot;
  };
}

export interface LoadedSessionState {
  agentState: LoadedAgentState | null;
  contextThinkingLevel?: string;
}

export function useSessionLoader(isNew: boolean) {
  const [data, setData] = useState<SessionData | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [error, setError] = useState<string | null>(null);
  const [activeLeafId, setActiveLeafId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [entryIds, setEntryIds] = useState<Array<string | undefined>>([]);
  const [branches, setBranches] = useState<SessionBranches | null>(null);

  // Latest-request-wins guard (M3): when sessions switch quickly, a stale
  // response must not overwrite newer state. The caller's `cancelled` flag
  // only guards its outer .then, not these setState calls.
  const loadReqIdRef = useRef(0);
  const loadContextReqIdRef = useRef(0);
  const branchReqIdRef = useRef(0);
  /**
   * 上一次成功上屏的会话 id + 当前对话条数。
   *
   * 用来区分「换了一个会话」和「同一个会话重新取了一次」：运行中的回合会反复打断
   * 重取（工具轮次抖动、宿主正在追加写盘），这时候一次返回空上下文**不等于**对话
   * 没了 —— 抹掉之后本轮结束前没有任何重载路径，界面就只剩一句「正在思考…」。
   */
  const loadedSidRef = useRef<string | null>(null);
  const shownCountRef = useRef(0);
  useEffect(() => {
    shownCountRef.current = messages.length;
  }, [messages.length]);

  const loadBranches = useCallback(async (sid: string, filePath?: string | null) => {
    const requestId = ++branchReqIdRef.current;
    try {
      const next = await fetchBranches(sid, filePath);
      // A newer session load wins; never show another session's branches.
      if (requestId !== branchReqIdRef.current) return null;
      setBranches(next);
      return next;
    } catch {
      // Branch switchers are optional chrome; keep the current tree on failure.
      return null;
    }
  }, []);

  const loadSession = useCallback(async (sid: string, showLoading = false, includeState = false): Promise<LoadedSessionState | null> => {
    const stale = latestRequestStale(loadReqIdRef);
    try {
      if (showLoading) setLoading(true);
      const d = await fetchSession(sid, includeState) as SessionData & { agentState?: LoadedAgentState } | null;
      if (stale()) return null;
      if (d === null) {
        if (showLoading) {
          // 一次没取到不等于会话没了：换会话/真删除由调用方自己清空，
          // 这里清掉就是「历史凭空消失」，而且没有任何后续重载能救回来。
          setData(null);
          setActiveLeafId(null);
          setBranches(null);
          setError(null);
        }
        return null;
      }
      const nextMessages = d.context.messages;
      const sameSession = loadedSidRef.current === sid;
      loadedSidRef.current = sid;
      // 同一个会话、这次拿到空上下文、而界面本来有内容 → 典型的「宿主正在写盘」
      // 竞态。保留已有对话，别把整段历史抹成空白。
      const keepShown =
        sameSession && nextMessages.length === 0 && shownCountRef.current > 0;
      setData(d);
      setActiveLeafId(d.leafId);
      if (!keepShown) {
        setMessages(nextMessages);
        setEntryIds(d.context.entryIds ?? []);
      }
      setError(null);
      // Fire-and-forget: the tree powers the inline 1/2 switchers.
      void loadBranches(sid, d.filePath);
      return { agentState: d.agentState ?? null, contextThinkingLevel: d.context.thinkingLevel };
    } catch (e) {
      if (stale()) return null;
      setError(String(e));
      return null;
    } finally {
      // Reset loading when the latest request settles (stale showLoading
      // requests may be superseded by a later showLoading=false request that
      // never set loading true — skipping the reset here would wedge it).
      if (!stale()) setLoading(false);
    }
  }, [loadBranches]);

  const loadContext = useCallback(async (sid: string, leafId: string | null) => {
    const stale = latestRequestStale(loadContextReqIdRef);
    try {
      const d = await fetchContext(sid, leafId);
      if (stale()) return;
      setMessages(d.context.messages);
      setEntryIds(d.context.entryIds ?? []);
    } catch (e) {
      if (stale()) return;
      console.error("Failed to load context:", e);
    }
  }, []);

  return {
    data,
    setData,
    loading,
    error,
    activeLeafId,
    setActiveLeafId,
    messages,
    setMessages,
    entryIds,
    setEntryIds,
    branches,
    setBranches,
    loadSession,
    loadContext,
    loadBranches,
  };
}
