"use client";

import {
  useState,
  useCallback,
  useRef,
  useEffect,
  useReducer,
  useMemo,
} from "react";
import type { SessionInfo, SessionTreeNode, UserMessage } from "@/lib/types";
import type { FollowUpQueueSnapshot } from "@/lib/follow-up-queue";
import type { PrefixAuditView } from "@/lib/token-guard";
import {
  calculateSessionActivity,
  calculateSessionStats,
  type SessionStats,
} from "./agent-session/session-stats";
import { type AgentPhase } from "./agent-session/agent-phase";
import {
  initialStreamingState,
  streamReducer,
} from "./agent-session/stream-state";
import { useChatScroll } from "./agent-session/use-chat-scroll";
import { useAgentEvents } from "./agent-session/use-agent-events";
import { useSessionLoader } from "./agent-session/use-session-loader";
import {
  applyAgentEvent,
  applyPhaseOp,
  type ContextUsage,
  type RetryInfo,
} from "./agent-session/agent-event-apply";
import {
  sessionScopedResetPatch,
  loadedAgentStatePatch,
  type ThinkingLevelOption,
} from "./agent-session/session-lifecycle-reset";
import { useSessionModelTools } from "./agent-session/use-session-model-tools";
import { useSessionCommands } from "./agent-session/use-session-commands";
import type {
  AttachedImage,
  ChatInputHandle,
} from "@/components/chat-input/types";
import type { AgentMode } from "@/lib/approval-policy";
import { DEFAULT_AGENT_MODE } from "@/lib/approval-policy";
import type { ExtensionUiRequestEvent } from "./agent-session/agent-events-manager";
import type { NeedsTrustPayload } from "@/lib/trust-types";
import type { ContextBudget } from "@/lib/pi-types";
import { sendAgentCommand } from "@/lib/agent-client";
import { reconcileOrAppendPendingUserMessage } from "./agent-session/user-message-reconciliation";
import { normalizeUserTextForMatch } from "../lib/image-dimension-note";

export type { ThinkingLevelOption, AttachedImage, ChatInputHandle };

export interface NestedToolExecution {
  status: "running" | "ok" | "error";
  durationMs?: number;
  output?: string;
}

function nestedOutputText(result: unknown): string {
  if (typeof result === "string") return result.slice(0, 8000);
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  if (typeof content === "string") return content.slice(0, 8000);
  if (!Array.isArray(content)) {
    try {
      return JSON.stringify(result).slice(0, 8000);
    } catch {
      return "";
    }
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
    else if (record.type === "image") parts.push("[图片结果]");
  }
  return parts.join("\n").slice(0, 8000);
}

const EMPTY_FOLLOW_UP_QUEUE: FollowUpQueueSnapshot = { revision: 0, items: [] };

function userMessageText(message: UserMessage): string {
  return typeof message.content === "string"
    ? message.content
    : message.content
        .filter(
          (block): block is { type: "text"; text: string } =>
            block.type === "text",
        )
        .map((block) => block.text)
        .join("\n");
}

function clearPendingDelivery(message: UserMessage): UserMessage {
  const delivered = { ...message };
  delete delivered.deliveryState;
  return delivered;
}

export interface UseAgentSessionOptions {
  session: SessionInfo | null;
  newSessionCwd: string | null;
  onAgentEnd?: () => void;
  /** Called inside the agent_end event handler, BEFORE business logic (state updates).
   *  Use this for side effects that should fire on every agent_end event
   *  (e.g., notification sounds). Distinct from onAgentEnd which is the
   *  parent-component-facing callback. */
  onAgentEndEvent?: () => void;
  onSessionCreated?: (session: SessionInfo) => void;
  onSessionForked?: (newSessionId: string) => void;
  onNewSession?: () => void;
  modelsRefreshKey?: number;
  onBranchDataChange?: (
    tree: SessionTreeNode[],
    activeLeafId: string | null,
    onLeafChange: (leafId: string | null) => void,
  ) => void;
  /** Fired when pi renames the session (auto title or manual rename). */
  onSessionRenamed?: (name: string | undefined) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  /** 当前标签页是否可见：用于滚动位置记忆与首次贴底。 */
  active?: boolean;
  /** 发送失败时的提示回调（宿主 / 网络错误），避免“输入没反应”。 */
  onPromptError?: (message: string) => void;
}

export function useAgentSession(opts: UseAgentSessionOptions) {
  const {
    session,
    newSessionCwd,
    onAgentEnd,
    onAgentEndEvent,
    onSessionCreated,
    onSessionForked,
    onNewSession,
    modelsRefreshKey,
    onBranchDataChange,
    onSystemPromptChange,
    onSessionRenamed,
    active = true,
    onPromptError,
  } = opts;

  const isNew = session === null && newSessionCwd !== null;

  const {
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
    loadSession: loadSessionFromApi,
    loadContext,
  } = useSessionLoader(isNew);

  const [streamState, dispatch] = useReducer(
    streamReducer,
    initialStreamingState,
  );
  const [agentRunning, setAgentRunning] = useState(false);
  const [retryInfo, setRetryInfo] = useState<RetryInfo | null>(null);
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  /**
   * 前缀审计的只读视图（P2-2 护栏用）：来自 `agent.state.prefixAudit`。
   * 只用于提示"前缀已失效"，不参与任何前缀生成逻辑。
   */
  const [prefixAudit, setPrefixAudit] = useState<PrefixAuditView | null>(null);
  const [contextBudget, setContextBudget] = useState<ContextBudget | null>(null);
  const [authoritativeSessionStats, setAuthoritativeSessionStats] =
    useState<SessionStats | null>(null);
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [forkingEntryId, setForkingEntryId] = useState<string | null>(null);
  const [isCompacting, setIsCompacting] = useState(false);
  const [compactError, setCompactError] = useState<string | null>(null);
  const [agentPhase, setAgentPhase] = useState<AgentPhase>(null);
  const [agentMode, setAgentMode] = useState<AgentMode>(DEFAULT_AGENT_MODE);
  const [canExecutePlan, setCanExecutePlan] = useState(false);
  const [extensionUiRequest, setExtensionUiRequest] =
    useState<ExtensionUiRequestEvent | null>(null);
  const [extensionUiNotify, setExtensionUiNotify] = useState<{
    message: string;
    notifyType: "info" | "warning" | "error";
  } | null>(null);
  const [trustPrompt, setTrustPrompt] = useState<NeedsTrustPayload | null>(
    null,
  );
  const [followUpQueue, setFollowUpQueue] = useState<FollowUpQueueSnapshot>(
    EMPTY_FOLLOW_UP_QUEUE,
  );
  const [followUpQueueBusy, setFollowUpQueueBusy] = useState(false);
  const [nestedToolExecutions, setNestedToolExecutions] = useState<
    Record<string, NestedToolExecution>
  >({});
  /**
   * 执行中工具的实时输出（按工具名索引，最新一次覆盖）。
   * 来自 pi 的 `tool_execution_update.partialResult`，只保留尾部 8KB，
   * 让工具卡能像终端一样边跑边刷。
   */
  const [liveToolOutput, setLiveToolOutput] = useState<Record<string, string>>({});
  const followUpQueueRef = useRef(followUpQueue);
  followUpQueueRef.current = followUpQueue;
  const pendingSteersRef = useRef<
    Array<{ id: string; message: string; glowing: boolean }>
  >([]);
  const pendingPromptsRef = useRef<Array<{ id: string; message: string }>>([]);
  const trustResolverRef = useRef<((optionId: string | null) => void) | null>(
    null,
  );
  const agentModeRef = useRef(agentMode);
  agentModeRef.current = agentMode;

  const acceptFollowUpQueue = useCallback((snapshot: FollowUpQueueSnapshot) => {
    if (snapshot.revision < followUpQueueRef.current.revision) return;
    followUpQueueRef.current = snapshot;
    setFollowUpQueue(snapshot);
  }, []);

  const handlePendingSteerQueued = useCallback(
    (item: { id: string; message: string }) => {
      pendingSteersRef.current.push({ ...item, glowing: true });
    },
    [],
  );

  const handlePendingSteerFailed = useCallback(
    (id: string) => {
      pendingSteersRef.current = pendingSteersRef.current.filter(
        (item) => item.id !== id,
      );
      setMessages((prev) =>
        prev.map((message) => {
          if (message.role !== "user" || message.clientMessageId !== id)
            return message;
          return clearPendingDelivery(message);
        }),
      );
    },
    [setMessages],
  );

  const handlePendingPromptQueued = useCallback(
    (item: { id: string; message: string }) => {
      pendingPromptsRef.current.push(item);
    },
    [],
  );

  const handlePendingPromptFailed = useCallback(
    (id: string) => {
      pendingPromptsRef.current = pendingPromptsRef.current.filter(
        (item) => item.id !== id,
      );
      setMessages((prev) =>
        prev.map((message) => {
          if (message.role !== "user" || message.clientMessageId !== id)
            return message;
          return clearPendingDelivery(message);
        }),
      );
    },
    [setMessages],
  );

  const reconcileSteeringQueue = useCallback(
    (steering: readonly string[]) => {
      const remaining = new Map<string, number>();
      for (const message of steering)
        remaining.set(message, (remaining.get(message) ?? 0) + 1);
      const deliveredIds = new Set<string>();
      pendingSteersRef.current = pendingSteersRef.current.map((item) => {
        if (!item.glowing) return item;
        const count = remaining.get(item.message) ?? 0;
        if (count > 0) {
          remaining.set(item.message, count - 1);
          return item;
        }
        deliveredIds.add(item.id);
        return { ...item, glowing: false };
      });
      if (!deliveredIds.size) return;
      setMessages((prev) =>
        prev.map((message) => {
          if (
            message.role !== "user" ||
            !message.clientMessageId ||
            !deliveredIds.has(message.clientMessageId)
          ) {
            return message;
          }
          return clearPendingDelivery(message);
        }),
      );
    },
    [setMessages],
  );

  const {
    messagesEndRef,
    scrollContainerRef,
    setScrollContainer,
    pendingScrollToUserRef,
    initialScrollDoneRef,
  } = useChatScroll({
    messageCount: messages.length,
    agentRunning,
    streamingMessage: streamState.streamingMessage,
    active,
  });

  const sessionIdRef = useRef<string | null>(session?.id ?? null);
  const { handleAgentEventRef, connectEvents, connectionStatus } =
    useAgentEvents({ agentRunning });

  const modelTools = useSessionModelTools({
    isNew,
    modelsRefreshKey,
    sessionIdRef,
  });

  const {
    modelNames,
    modelList,
    modelThinkingLevels,
    modelThinkingLevelMaps,
    newSessionModel,
    toolPreset,
    setToolPreset,
    thinkingLevel,
    setThinkingLevel,
    currentModelOverride,
    setCurrentModelOverride,
    autoRouting,
    resolveAutoModelForPrompt,
    pendingModel,
    setPendingModel,
    loadTools,
    handleModelChange,
    handleThinkingLevelChange,
    handleToolPresetChange,
  } = modelTools;

  const currentModel = useMemo(
    () => currentModelOverride ?? data?.context.model ?? pendingModel ?? null,
    [currentModelOverride, data?.context.model, pendingModel],
  );
  const displayModel = useMemo(
    () =>
      autoRouting
        ? { provider: "auto", modelId: "auto" }
        : isNew
          ? newSessionModel
          : currentModel,
    [autoRouting, isNew, newSessionModel, currentModel],
  );
  const calculatedSessionStats = useMemo(
    () => calculateSessionStats(messages),
    [messages],
  );
  const contextChars = useMemo(
    () =>
      messages.reduce((total, message) => {
        const content = (message as { content?: unknown }).content;
        if (typeof content === "string") return total + content.length;
        if (!Array.isArray(content)) return total;
        return (
          total +
          content.reduce((sum, block) => {
            const text = (block as { text?: unknown }).text;
            return sum + (typeof text === "string" ? text.length : 0);
          }, 0)
        );
      }, 0),
    [messages],
  );
  const sessionStats = authoritativeSessionStats ?? calculatedSessionStats;
  // 回合数 / 工具调用汇总：直接由 transcript 推导，不依赖 host 侧 stats。
  const sessionActivity = useMemo(
    () => calculateSessionActivity(messages),
    [messages],
  );

  const loadSession = useCallback(
    async (sid: string, showLoading = false, includeState = false) => {
      // A canonical transcript replaces any optimistic delivery state. Clear
      // the matching refs first so a later same-text event cannot consume a
      // stale client id and suppress a real message.
      pendingPromptsRef.current = [];
      pendingSteersRef.current = [];
      const loaded = await loadSessionFromApi(sid, showLoading, includeState);
      if (loaded) setCurrentModelOverride(null);
      return loaded;
    },
    [loadSessionFromApi, setCurrentModelOverride],
  );

  const promptTrust = useCallback((payload: NeedsTrustPayload) => {
    return new Promise<string | null>((resolve) => {
      trustResolverRef.current = resolve;
      setTrustPrompt(payload);
    });
  }, []);

  const resolveTrustPrompt = useCallback((optionId: string | null) => {
    setTrustPrompt(null);
    const r = trustResolverRef.current;
    trustResolverRef.current = null;
    r?.(optionId);
  }, []);

  const handleExtensionUiRespond = useCallback(
    async (payload: {
      id: string;
      confirmed?: boolean;
      value?: string;
      cancelled?: boolean;
    }) => {
      setExtensionUiRequest(null);
      const sid = sessionIdRef.current;
      if (!sid) return;
      try {
        await sendAgentCommand(sid, {
          type: "extension_ui_response",
          ...payload,
        });
      } catch (e) {
        console.error("extension_ui_response failed:", e);
      }
    },
    [],
  );

  const handleAgentEvent = useCallback(
    (event: Parameters<typeof applyAgentEvent>[0]) => {
      if (event.type === "follow_up_queue_update") {
        acceptFollowUpQueue({ revision: event.revision, items: event.items });
      } else if (event.type === "queue_update") {
        reconcileSteeringQueue(event.steering);
      } else if (event.type === "session_info_changed") {
        onSessionRenamed?.(event.name);
      }

      if (event.type === "tool_execution_update") {
        const text = nestedOutputText(event.partialResult);
        // 开发期确认"工具日志真的在流"：F12 Console 会源源不断刷 [Tool Stream]。
        if (process.env.NODE_ENV !== "production") {
          console.log("[Tool Stream]", event.toolName, text.slice(-200));
        }
        setLiveToolOutput((previous) => ({
          ...previous,
          [event.toolName]: text.slice(-8000),
        }));
      }
      if (event.type === "tool_execution_end") {
        const finishedName = event.toolName;
        if (finishedName) {
          setLiveToolOutput((previous) => {
            if (!(finishedName in previous)) return previous;
            const next = { ...previous };
            delete next[finishedName];
            return next;
          });
        }
      }

      // Nested tool results are not persisted by pi (only name/args/status).
      // Capture them from the live SSE stream so the execution tree can show
      // each child call's stdout/result while the session is open.
      if (event.type === "tool_execution_start" && event.parentToolCallId) {
        setNestedToolExecutions((prev) => ({
          ...prev,
          [event.toolCallId]: { status: "running" },
        }));
      } else if (event.type === "tool_execution_end" && event.parentToolCallId) {
        setNestedToolExecutions((prev) => ({
          ...prev,
          [event.toolCallId]: {
            status: event.isError ? "error" : "ok",
            durationMs: event.durationMs,
            output: nestedOutputText(event.result),
          },
        }));
      }

      let reconciledSteerId: string | null = null;
      let reconciledPromptId: string | null = null;
      if (event.type === "message_end" && event.message.role === "user") {
        // 带图消息落盘时 pi 会在文本尾部追加坐标说明，直接比原文会匹配不上，
        // 于是乐观气泡留着、落盘消息又插一条 —— 界面出现两条相同的用户消息。
        const canonicalText = normalizeUserTextForMatch(userMessageText(event.message));
        const sameAs = (item: { message: string }) =>
          normalizeUserTextForMatch(item.message) === canonicalText;
        const pendingIndex = pendingSteersRef.current.findIndex(sameAs);
        if (pendingIndex !== -1) {
          reconciledSteerId = pendingSteersRef.current[pendingIndex].id;
          pendingSteersRef.current.splice(pendingIndex, 1);
        } else {
          const promptIndex = pendingPromptsRef.current.findIndex(sameAs);
          if (promptIndex !== -1) {
            reconciledPromptId = pendingPromptsRef.current[promptIndex].id;
            pendingPromptsRef.current.splice(promptIndex, 1);
          }
        }
      }
      const result = applyAgentEvent(event);

      if (
        reconciledSteerId &&
        event.type === "message_end" &&
        event.message.role === "user"
      ) {
        const clientMessageId = reconciledSteerId;
        const canonical = event.message;
        result.appendMessages = undefined;
        setMessages((prev) =>
          prev.map((message) => {
            if (
              message.role !== "user" ||
              message.clientMessageId !== clientMessageId
            )
              return message;
            return { ...canonical, timestamp: message.timestamp };
          }),
        );
      }

      if (
        reconciledPromptId &&
        event.type === "message_end" &&
        event.message.role === "user"
      ) {
        const clientMessageId = reconciledPromptId;
        const canonical = event.message;
        result.appendMessages = undefined;
        setMessages((prev) =>
          reconcileOrAppendPendingUserMessage(prev, canonical, clientMessageId),
        );
        setEntryIds((prev) => [...prev, undefined]);
      }

      if (result.agentRunning !== undefined)
        setAgentRunning(result.agentRunning);
      if (result.phaseOp) {
        setAgentPhase((prev) => applyPhaseOp(prev, result.phaseOp!));
      }
      if (result.streamAction) dispatch(result.streamAction);
      if (result.retryInfo !== undefined) setRetryInfo(result.retryInfo);
      if (result.isCompacting !== undefined)
        setIsCompacting(result.isCompacting);
      if (result.compactError !== undefined)
        setCompactError(result.compactError);
      if (result.appendMessages?.length) {
        const appended = result.appendMessages!;
        // Pure updater: a side-effect-free spread (React StrictMode can
        // double-invoke updaters during render, so setCanExecutePlan must live
        // outside the updater, below).
        setMessages((prev) => [...prev, ...appended]);
        // Keep entryIds parallel with messages. SSE message events don't carry
        // the session entry id, so the new slots stay undefined until the next
        // reload populates real ids; MessageList falls back to idx keys, gates
        // fork/navigate on a truthy entryId, and handleFork guards empty ids.
        setEntryIds((prev) => [...prev, ...appended.map(() => undefined)]);
        if (agentModeRef.current === "plan") {
          const last = appended[appended.length - 1];
          if (last && last.role === "assistant") {
            const text =
              typeof last.content === "string"
                ? last.content
                : Array.isArray(last.content)
                  ? last.content
                      .filter(
                        (b): b is { type: "text"; text: string } =>
                          b.type === "text",
                      )
                      .map((b) => b.text)
                      .join("")
                  : "";
            if (text.trim()) setCanExecutePlan(true);
          }
        }
      }

      for (const effect of result.effects) {
        switch (effect.type) {
          case "onAgentEndEvent":
            onAgentEndEvent?.();
            break;
          case "onAgentEnd":
            onAgentEnd?.();
            break;
          case "reloadSession":
            if (sessionIdRef.current) loadSession(sessionIdRef.current);
            break;
          case "fetchAgentState":
            if (sessionIdRef.current) {
              fetch(`/api/agent/${encodeURIComponent(sessionIdRef.current)}`)
                .then((r) => r.json())
                .then(
                  (d: {
                    state?: {
                      contextUsage?: ContextUsage | null;
                      sessionStats?: SessionStats | null;
                      systemPrompt?: string;
                      agentMode?: AgentMode;
                      followUpQueue?: FollowUpQueueSnapshot;
                      prefixAudit?: PrefixAuditView | null;
                    };
                  }) => {
                    if (d.state?.contextUsage !== undefined) {
                      setContextUsage(d.state.contextUsage ?? null);
                    }
                    if (d.state?.sessionStats !== undefined) {
                      setAuthoritativeSessionStats(d.state.sessionStats ?? null);
                    }
                    if (d.state?.systemPrompt !== undefined) {
                      setSystemPrompt(d.state.systemPrompt ?? null);
                    }
                    if (d.state?.agentMode) setAgentMode(d.state.agentMode);
                    if (d.state?.followUpQueue)
                      acceptFollowUpQueue(d.state.followUpQueue);
                    if (d.state?.prefixAudit !== undefined) setPrefixAudit(d.state.prefixAudit ?? null);
                  },
                )
                .catch((err) => {
                  console.error("Agent end fetch failed:", err);
                });
            }
            break;
          case "consoleError":
            console.error("Agent error from server:", effect.message);
            break;
          case "extensionUiRequest":
            setExtensionUiRequest(effect.request);
            break;
          case "extensionUiNotify":
            setExtensionUiNotify({
              message: effect.message,
              notifyType: effect.notifyType,
            });
            break;
        }
      }
    },
    [
      acceptFollowUpQueue,
      loadSession,
      onAgentEnd,
      onAgentEndEvent,
      onSessionRenamed,
      reconcileSteeringQueue,
      setMessages,
      setEntryIds,
      setCanExecutePlan,
    ],
  );
  handleAgentEventRef.current = handleAgentEvent;

  const commands = useSessionCommands({
    session,
    newSessionCwd,
    isNew,
    agentRunning,
    isCompacting,
    autoRouting,
    resolveAutoModelForPrompt,
    contextChars,
    toolPreset,
    agentMode,
    setAgentMode,
    thinkingLevel,
    newSessionModel,
    sessionIdRef,
    sessionFilePath: data?.filePath ?? null,
    pendingScrollToUserRef,
    setMessages,
    setEntryIds,
    setAgentRunning,
    setAgentPhase,
    dispatch,
    setPendingModel,
    setIsCompacting,
    setCompactError,
    setForkingEntryId,
    setActiveLeafId,
    setCanExecutePlan,
    promptTrust,
    loadSession,
    loadContext,
    connectEvents,
    onSessionCreated,
    onSessionForked,
    onNewSession,
    onFollowUpQueueSnapshot: acceptFollowUpQueue,
    onPendingSteerQueued: handlePendingSteerQueued,
    onPendingSteerFailed: handlePendingSteerFailed,
    onPendingPromptQueued: handlePendingPromptQueued,
    onPendingPromptFailed: handlePendingPromptFailed,
    onPromptError,
  });

  const handleReorderFollowUps = useCallback(
    async (orderedIds: string[]) => {
      if (followUpQueueBusy) return;
      const previous = followUpQueueRef.current;
      if (
        orderedIds.length !== previous.items.length ||
        orderedIds.every((id, index) => id === previous.items[index]?.id)
      )
        return;
      const byId = new Map(previous.items.map((item) => [item.id, item]));
      const optimistic: FollowUpQueueSnapshot = {
        revision: previous.revision,
        items: orderedIds
          .map((id) => byId.get(id))
          .filter((item): item is FollowUpQueueSnapshot["items"][number] =>
            Boolean(item),
          ),
      };
      if (optimistic.items.length !== previous.items.length) return;
      followUpQueueRef.current = optimistic;
      setFollowUpQueue(optimistic);
      setFollowUpQueueBusy(true);
      const sid = sessionIdRef.current;
      if (!sid) {
        acceptFollowUpQueue(previous);
        setFollowUpQueueBusy(false);
        return;
      }
      try {
        const snapshot = await sendAgentCommand<FollowUpQueueSnapshot>(sid, {
          type: "reorder_follow_ups",
          orderedIds,
          expectedRevision: previous.revision,
        });
        acceptFollowUpQueue(snapshot);
      } catch (error) {
        console.error("Failed to reorder follow-ups:", error);
        try {
          const state = await sendAgentCommand<{
            followUpQueue?: FollowUpQueueSnapshot;
          }>(sid, { type: "get_state" });
          if (state.followUpQueue) acceptFollowUpQueue(state.followUpQueue);
        } catch {
          if (followUpQueueRef.current.revision === previous.revision) {
            followUpQueueRef.current = previous;
            setFollowUpQueue(previous);
          }
        }
      } finally {
        setFollowUpQueueBusy(false);
      }
    },
    [acceptFollowUpQueue, followUpQueueBusy, sessionIdRef],
  );

  /**
   * 删除单条排队消息：先本地乐观移除，再让宿主真正出队。
   *
   * 宿主是队列的唯一真相；只删本地的话下一次 `follow_up_queue_update` 快照会把它
   * 请回来。失败时重新拉一次状态对齐（revision 冲突同理）。
   */
  const handleRemoveFollowUp = useCallback(
    async (id: string) => {
      if (followUpQueueBusy) return;
      const previous = followUpQueueRef.current;
      if (!previous.items.some((item) => item.id === id)) return;
      const optimistic: FollowUpQueueSnapshot = {
        revision: previous.revision,
        items: previous.items.filter((item) => item.id !== id),
      };
      followUpQueueRef.current = optimistic;
      setFollowUpQueue(optimistic);
      const sid = sessionIdRef.current;
      if (!sid) return;
      setFollowUpQueueBusy(true);
      try {
        const snapshot = await sendAgentCommand<FollowUpQueueSnapshot>(sid, {
          type: "remove_follow_up",
          id,
          expectedRevision: previous.revision,
        });
        acceptFollowUpQueue(snapshot);
      } catch (error) {
        console.error("Failed to remove follow-up:", error);
        try {
          const state = await sendAgentCommand<{
            followUpQueue?: FollowUpQueueSnapshot;
          }>(sid, { type: "get_state" });
          if (state.followUpQueue) acceptFollowUpQueue(state.followUpQueue);
        } catch {
          if (followUpQueueRef.current.revision === previous.revision) {
            followUpQueueRef.current = previous;
            setFollowUpQueue(previous);
          }
        }
      } finally {
        setFollowUpQueueBusy(false);
      }
    },
    [acceptFollowUpQueue, followUpQueueBusy, sessionIdRef],
  );

  // Load session on mount AND on session change.
  //
  // On session change, reset all session-scoped state to avoid bleed
  // from a previous session. AppShell's sessionKey remount is kept
  // as defense-in-depth (covers state in sub-hooks like
  // useChatScroll / useAgentEvents that we can't reset from here).
  useEffect(() => {
    if (!session) return;
    const sid = session.id;
    sessionIdRef.current = sid;
    let cancelled = false;

    const reset = sessionScopedResetPatch();
    setData(null);
    setActiveLeafId(null);
    setMessages([]);
    setEntryIds([]);
    setToolPreset(reset.toolPreset);
    setThinkingLevel(reset.thinkingLevel);
    setAgentRunning(reset.agentRunning);
    setAgentPhase(reset.agentPhase);
    dispatch({ type: "reset" });
    setRetryInfo(reset.retryInfo);
    setContextUsage(reset.contextUsage);
    setPrefixAudit(null);
    setAuthoritativeSessionStats(null);
    setSystemPrompt(reset.systemPrompt);
    setForkingEntryId(reset.forkingEntryId);
    setIsCompacting(reset.isCompacting);
    setCompactError(reset.compactError);
    setCurrentModelOverride(reset.currentModelOverride);
    setPendingModel(reset.pendingModel);
    setAgentMode(DEFAULT_AGENT_MODE);
    setCanExecutePlan(false);
    setExtensionUiRequest(null);
    followUpQueueRef.current = EMPTY_FOLLOW_UP_QUEUE;
    setFollowUpQueue(EMPTY_FOLLOW_UP_QUEUE);
    setNestedToolExecutions({});
    setLiveToolOutput({});
    setFollowUpQueueBusy(false);
    pendingSteersRef.current = [];
    pendingPromptsRef.current = [];

    fetch("/api/desktop-settings")
      .then((r) => r.json())
      .then((d: { defaultAgentMode?: AgentMode }) => {
        if (!cancelled && d.defaultAgentMode) setAgentMode(d.defaultAgentMode);
      })
      .catch(() => {});

    loadSessionFromApi(sid, true, true).then((loaded) => {
      if (cancelled) return;
      const patch = loadedAgentStatePatch({
        agentState: loaded?.agentState ?? null,
        contextThinkingLevel: loaded?.contextThinkingLevel ?? null,
      });
      if (patch.thinkingLevel !== undefined)
        setThinkingLevel(patch.thinkingLevel);
      if (patch.loadTools) loadTools(sid);
      if (patch.agentRunning) setAgentRunning(true);
      if (patch.agentPhaseWaitingModel)
        setAgentPhase({ kind: "waiting_model" });
      if (patch.connectEvents) connectEvents(sid);
      if (patch.isCompacting !== undefined) setIsCompacting(patch.isCompacting);
      if (patch.contextUsage !== undefined) setContextUsage(patch.contextUsage);
      if (patch.contextBudget !== undefined) setContextBudget(patch.contextBudget);
      if (loaded?.agentState?.state?.sessionStats !== undefined) {
        setAuthoritativeSessionStats(loaded.agentState.state.sessionStats ?? null);
      }
      if (patch.systemPrompt !== undefined) setSystemPrompt(patch.systemPrompt);
      const loadedQueue = loaded?.agentState?.state?.followUpQueue;
      if (loadedQueue) acceptFollowUpQueue(loadedQueue);
    });

    return () => {
      cancelled = true;
    };
    // useState setters are reference-stable but exhaustive-deps
    // doesn't recognize them as such; deps is intentionally
    // [session?.id] only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id]);

  useEffect(() => {
    onSystemPromptChange?.(systemPrompt);
  }, [systemPrompt, onSystemPromptChange]);

  useEffect(() => {
    if (!onBranchDataChange) return;
    onBranchDataChange(
      data?.tree ?? [],
      activeLeafId,
      commands.handleLeafChange,
    );
  }, [data?.tree, activeLeafId, commands.handleLeafChange, onBranchDataChange]);

  // Compact error auto-dismiss
  useEffect(() => {
    if (!compactError) return;
    const t = setTimeout(() => setCompactError(null), 3000);
    return () => clearTimeout(t);
  }, [compactError]);

  // Load global default mode for brand-new sessions
  useEffect(() => {
    if (!isNew) return;
    fetch("/api/desktop-settings")
      .then((r) => r.json())
      .then(
        (d: {
          defaultAgentMode?: AgentMode;
          defaultToolPreset?: "none" | "default" | "full";
        }) => {
          if (d.defaultAgentMode) setAgentMode(d.defaultAgentMode);
          if (d.defaultToolPreset) setToolPreset(d.defaultToolPreset);
        },
      )
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNew]);

  // Auto-clear notify toast
  useEffect(() => {
    if (!extensionUiNotify) return;
    const t = setTimeout(() => setExtensionUiNotify(null), 4000);
    return () => clearTimeout(t);
  }, [extensionUiNotify]);

  return {
    // State
    loading,
    error,
    messages,
    entryIds,
    branches,
    streamState,
    agentRunning,
    modelNames,
    modelList,
    modelThinkingLevels,
    modelThinkingLevelMaps,
    agentMode,
    canExecutePlan,
    extensionUiRequest,
    extensionUiNotify,
    trustPrompt,
    resolveTrustPrompt,
    handleExtensionUiRespond,
    toolPreset,
    thinkingLevel,
    retryInfo,
    contextUsage,
    prefixAudit,
    contextBudget,
    systemPrompt,
    forkingEntryId,
    isCompacting,
    compactError,
    displayModel,
    sessionStats,
    sessionActivity,
    /** 手动重试会话加载（错误卡片上的「重试」按钮）。 */
    loadSession,
    agentPhase,
    followUpQueue,
    followUpQueueBusy,
    nestedToolExecutions,
    liveToolOutput,
    isNew,
    // Refs
    messagesEndRef,
    scrollContainerRef,
    setScrollContainer,
    pendingScrollToUserRef,
    initialScrollDoneRef,
    // Actions
    handleSend: commands.handleSend,
    handleAgentModeChange: commands.handleAgentModeChange,
    handleExecutePlan: commands.handleExecutePlan,
    dismissPlan: commands.dismissPlan,
    handleAbort: commands.handleAbort,
    handleFork: commands.handleFork,
    handleBranchAt: commands.handleBranchAt,
    handleNavigate: commands.handleNavigate,
    handleLeafChange: commands.handleLeafChange,
    handleModelChange,
    handleCompact: commands.handleCompact,
    handleSteer: commands.handleSteer,
    handleFollowUp: commands.handleFollowUp,
    handleReorderFollowUps,
    handleRemoveFollowUp,
    handleAbortCompaction: commands.handleAbortCompaction,
    handleToolPresetChange,
    handleThinkingLevelChange,
    connectEvents,
    connectionStatus,
  };
}
