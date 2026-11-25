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
import { formatCodemodeProgressFromResult } from "@/lib/codemode-progress";
import {
  applyPlanCall,
  isPlanSettled,
  planFromMessages,
  planKey,
  planRemainingSteps,
  type PlanProgress,
} from "@/lib/plan-progress";
import {
  calculateSessionActivity,
  calculateSessionStats,
  registerModelCurrencies,
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
import {
  useSessionCommands,
  type PromptErrorContext,
} from "./agent-session/use-session-commands";
import type {
  AttachedImage,
  ChatInputHandle,
} from "@/components/chat-input/types";
import type { AgentMode } from "@/lib/approval-policy";
import { DEFAULT_AGENT_MODE } from "@/lib/approval-policy";
import type { ExtensionUiRequestEvent } from "./agent-session/agent-events-manager";
import type { NeedsTrustPayload } from "@/lib/trust-types";
import { describeContextBudget } from "@/lib/context-budget";
import { sendAgentCommand } from "@/lib/agent-client";
import { reconcileOrAppendPendingUserMessage } from "./agent-session/user-message-reconciliation";
import { normalizeUserTextForMatch } from "../lib/image-dimension-note";
import { markToolEnded } from "@/lib/tool-clock";

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

/**
 * 宿主**明确拒收**（会话忙 / 重载 / 断线）：这条消息从没进过会话。
 * 不能清成「已送达」——清掉之后气泡和正常消息长得一模一样，
 * 用户就会一直等一个不会来的回复。标记出来，气泡上才有「未送达」。
 */
function markDeliveryFailed(message: UserMessage): UserMessage {
  return { ...message, deliveryState: "failed" };
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
  onPromptError?: (message: string, context?: PromptErrorContext) => void;
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
  /**
   * 上下文预算在**前端**由 `contextUsage` 现算，不再单独存一份。
   *
   * 曾经的坑：host 的 `get_state` 快照里同时给了 contextUsage 与 contextBudget，
   * 但只有 contextUsage 在 agent 结束时被前端刷新，contextBudget 停留在会话加载
   * 时的旧值 —— 于是「用量与额度」显示 22.1%，输入框下面那一行还写着 0.7%。
   * 预算本来就是 contextUsage 的纯函数，现算就不可能再对不上。
   */
  const contextBudget = useMemo(
    () =>
      contextUsage
        ? describeContextBudget({
            tokens: contextUsage.tokens,
            contextWindow: contextUsage.contextWindow,
          })
        : null,
    [contextUsage]
  );
  const [authoritativeSessionStats, setAuthoritativeSessionStats] =
    useState<SessionStats | null>(null);
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [forkingEntryId, setForkingEntryId] = useState<string | null>(null);
  const [isCompacting, setIsCompacting] = useState(false);
  const [compactError, setCompactError] = useState<string | null>(null);
  /**
   * 「刚刚压缩完毕」的一次性通知（自动压缩也会发）。
   * 由 ChatSurface 消费后调 `clearCompactionNotice()` 清掉，避免重复弹。
   */
  const [compactionNotice, setCompactionNotice] = useState<{
    reason: string;
    tokensBefore: number | null;
    tokensAfter: number | null;
  } | null>(null);
  const [agentPhase, setAgentPhase] = useState<AgentPhase>(null);
  /**
   * 每次 tool_execution_end 自增一次，只用来给「正在跑什么」的徽章当重算触发点。
   * 已结束的登记表在 lib/tool-clock.ts（模块级 Map，不是 state），光改它不会渲染。
   */
  const [toolEndTick, setToolEndTick] = useState(0);
  const [agentMode, setAgentMode] = useState<AgentMode>(DEFAULT_AGENT_MODE);
  const [canExecutePlan, setCanExecutePlan] = useState(false);
  /** 计划进度卡片开关（desktop-settings，默认开）；关掉时连折叠计算都跳过。 */
  const [planProgressEnabled, setPlanProgressEnabled] = useState(true);
  /**
   * 本轮执行中折叠出来的进度（来自 SSE 的 plan 事件，含 codemode 脚本内的嵌套调用）。
   * 历史轮次靠 planFromMessages 从消息里重建，所以这里只服务「正在跑的这一轮」。
   */
  const [livePlan, setLivePlan] = useState<PlanProgress | null>(null);
  /**
   * 用户点过"放弃剩余"的那份计划的指纹（planKey）。
   * 存在前端而不是改成 dropped 写回会话：结算是一次 UI 决定，不该为了
   * 关掉一行卡片就再跑一轮 agent（花钱、还可能把计划重写一遍）。
   */
  const [abandonedPlanKey, setAbandonedPlanKey] = useState<string | null>(null);
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
          return markDeliveryFailed(message);
        }),
      );
    },
    [setMessages],
  );

  const handlePendingPromptQueued = useCallback(
    (item: { id: string; message: string }) => {
      pendingPromptsRef.current.push(item);
      /**
       * 新的一轮一发出，上一轮的 livePlan 立刻作废。
       *
       * livePlan 只是「正在跑的这一轮」的进度快照，它靠 agent_start 事件清零；
       * 而从按下发送到 agent_start 抵达之间有 1–2s 的 Host 往返。这期间
       * planProgress 会拿上一轮那张已经 5/5 的计划冒充本轮进度：输入框上方挂着
       * 一张"已完成"的卡（转录里同一张冻结卡又被 planCardInComposer 抑制），
       * 等 agent_start 到了才消失、然后漂回转录末尾 —— 就是用户看到的"残留
       * 跟着流式往下走"。新用户消息在同一批 setState 里落进 messages，
       * sinceLastUser 边界随之推进，这里清干净就不会再翻出上一轮。
       */
      setLivePlan(null);
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
          return markDeliveryFailed(message);
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
  const {
    handleAgentEventRef,
    connectEvents,
    reconnectEvents,
    getLastAgentEventAt,
    getLastRealAgentEventAt,
    connectionStatus,
    reconnectAttempts,
  } = useAgentEvents({ agentRunning });

  const modelTools = useSessionModelTools({
    isNew,
    modelsRefreshKey,
    sessionIdRef,
    // 与发送失败共用同一条 toast 通道：切模型失败同样不能静默。
    onModelChangeError: onPromptError,
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
    sceneState,
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
  // 计价方案（每个模型的计价币种）随模型配置变化，版本号变化时重算会话成本。
  const [pricingVersion, setPricingVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/model-pricing")
      .then((res) => (res.ok ? (res.json() as Promise<{ currencies?: Record<string, string> }>) : null))
      .then((data) => {
        if (cancelled) return;
        registerModelCurrencies(data?.currencies ?? null);
        setPricingVersion((v) => v + 1);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const calculatedSessionStats = useMemo(
    () => calculateSessionStats(messages),
    [messages, pricingVersion],
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

  /**
   * 低频 / 顺序敏感事件的处理体（原 handleAgentEvent 的全部逻辑）。
   * 由下面的 handleAgentEvent 按帧合并后再调用。
   */
  const applyAgentEventNow = useCallback(
    (event: Parameters<typeof applyAgentEvent>[0]) => {
      if (event.type === "follow_up_queue_update") {
        acceptFollowUpQueue({ revision: event.revision, items: event.items });
      } else if (event.type === "queue_update") {
        reconcileSteeringQueue(event.steering);
      } else if (event.type === "session_info_changed") {
        onSessionRenamed?.(event.name);
      }

      if (event.type === "tool_execution_update") {
        // codemode 脚本的 `content` 是空数组，只有 `details.calls`：此时折成一行调用进度，
        // 否则长脚本执行期间工具卡会一直停在「正在执行…」。
        const text =
          nestedOutputText(event.partialResult) || formatCodemodeProgressFromResult(event.partialResult);
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
        // 卡片秒表以事件流为准：消息里不一定有能匹配上的 toolResult，只信它会一直数下去。
        markToolEnded(event.toolCallId, event.durationMs);
        setToolEndTick((tick) => tick + 1);
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
      if (result.planOp) {
        const op = result.planOp;
        setLivePlan((prev) => (op.type === "reset" ? null : applyPlanCall(prev, op.args)));
      }
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
          case "compactionNotice":
            setCompactionNotice({
              reason: effect.reason,
              tokensBefore: effect.tokensBefore,
              tokensAfter: effect.tokensAfter,
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
  /**
   * 高频增量事件按帧合并。
   *
   * SSE 是按 chunk 来的：一次生成里 message_update 可能有上百条，
   * tool_execution_update 在长命令下更密。以前每条都直接 setState，
   * 等于每条都重渲 ChatSurface + 重解析 Markdown + 整块重绘
   * （软件合成机器上 GPU 进程能顶到 80%+）。
   *
   * 这两类事件携带的都是**全量快照**，同一帧内只保留最后一条即可；
   * 非增量事件（message_end / agent_end / error / queue 变更…）必须立刻执行，
   * 且执行前先把队列冲刷干净，避免 end 抢在 update 前面。
   */
  const pendingEventsRef = useRef<Array<Parameters<typeof applyAgentEvent>[0]>>([]);
  const eventFrameRef = useRef<number | null>(null);
  const handleAgentEvent = useCallback(
    (event: Parameters<typeof applyAgentEvent>[0]) => {
      const canAnimate =
        typeof window !== "undefined" && typeof window.requestAnimationFrame === "function";
      const drain = () => {
        const batch = pendingEventsRef.current;
        pendingEventsRef.current = [];
        for (const item of batch) applyAgentEventNow(item);
      };
      const isIncremental =
        event.type === "message_update" || event.type === "tool_execution_update";
      if (!isIncremental || !canAnimate) {
        // 先冲刷，保证「增量 → 终结」的因果顺序不被打乱。
        if (eventFrameRef.current !== null) {
          window.cancelAnimationFrame(eventFrameRef.current);
          eventFrameRef.current = null;
        }
        drain();
        applyAgentEventNow(event);
        return;
      }
      const queue = pendingEventsRef.current;
      const last = queue[queue.length - 1];
      if (last && last.type === event.type) queue[queue.length - 1] = event;
      else queue.push(event);
      if (eventFrameRef.current === null) {
        eventFrameRef.current = window.requestAnimationFrame(() => {
          eventFrameRef.current = null;
          drain();
        });
      }
    },
    [applyAgentEventNow],
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

  /**
   * 队列命令失败后的统一善后：先拉宿主状态对齐（revision 冲突 / 出队失败都一样），
   * 连拉都失败才回滚到本地旧快照。宿主是队列的唯一真相，本地自作主张会分叉。
   */
  const resyncFollowUpQueue = useCallback(
    async (sid: string, previous: FollowUpQueueSnapshot) => {
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
    },
    [acceptFollowUpQueue],
  );

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
        await resyncFollowUpQueue(sid, previous);
      } finally {
        setFollowUpQueueBusy(false);
      }
    },
    [acceptFollowUpQueue, followUpQueueBusy, resyncFollowUpQueue, sessionIdRef],
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
        await resyncFollowUpQueue(sid, previous);
      } finally {
        setFollowUpQueueBusy(false);
      }
    },
    [acceptFollowUpQueue, followUpQueueBusy, resyncFollowUpQueue, sessionIdRef],
  );

  /**
   * 原地编辑排队消息：只改文案，位置、附件、排队顺序一律不动。
   * 本地先乐观改（打字时界面必须立刻跟上），宿主成功后以它的快照为准。
   */
  const handleUpdateFollowUp = useCallback(
    async (id: string, message: string) => {
      const text = message.trim();
      if (!text || followUpQueueBusy) return;
      const previous = followUpQueueRef.current;
      const target = previous.items.find((item) => item.id === id);
      if (!target || target.message === text) return;
      const optimistic: FollowUpQueueSnapshot = {
        revision: previous.revision,
        items: previous.items.map((item) => (item.id === id ? { ...item, message: text } : item)),
      };
      followUpQueueRef.current = optimistic;
      setFollowUpQueue(optimistic);
      const sid = sessionIdRef.current;
      if (!sid) return;
      setFollowUpQueueBusy(true);
      try {
        const snapshot = await sendAgentCommand<FollowUpQueueSnapshot>(sid, {
          type: "update_follow_up",
          id,
          message: text,
          expectedRevision: previous.revision,
        });
        acceptFollowUpQueue(snapshot);
      } catch (error) {
        console.error("Failed to update follow-up:", error);
        await resyncFollowUpQueue(sid, previous);
      } finally {
        setFollowUpQueueBusy(false);
      }
    },
    [acceptFollowUpQueue, followUpQueueBusy, resyncFollowUpQueue, sessionIdRef],
  );

  /**
   * 排队消息「立即发送」：流式中走 steer 打断当前这一轮，空闲时直接开新一轮。
   * 宿主负责保留图片与失败回滚，这里只做乐观出队（失败后以宿主快照为准，
   * 那条消息会带着原位置回到队列里）。
   */
  const handleExpediteFollowUp = useCallback(
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
          type: "expedite_follow_up",
          id,
          expectedRevision: previous.revision,
        });
        acceptFollowUpQueue(snapshot);
      } catch (error) {
        console.error("Failed to send follow-up now:", error);
        await resyncFollowUpQueue(sid, previous);
        throw error;
      } finally {
        setFollowUpQueueBusy(false);
      }
    },
    [acceptFollowUpQueue, followUpQueueBusy, resyncFollowUpQueue, sessionIdRef],
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
    setLivePlan(null);
    setAbandonedPlanKey(null);
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
      .then((d: { defaultAgentMode?: AgentMode; planProgressEnabled?: boolean }) => {
        if (cancelled) return;
        if (d.defaultAgentMode) setAgentMode(d.defaultAgentMode);
        if (typeof d.planProgressEnabled === "boolean") setPlanProgressEnabled(d.planProgressEnabled);
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

  const clearCompactionNotice = useCallback(() => setCompactionNotice(null), []);

  /**
   * 计划进度：只认最后一次 `plan` 工具调用折叠出来的状态。
   * 历史消息里的 plan 调用不重复渲染，卡片永远只有一张。
   */
  /**
   * 计划卡片的去留。
   *
   * 旧实现是「本轮结束且不在等批准 → 直接不渲染」，于是计划停在 3/6 时
   * 卡片凭空消失：用户不知道还剩什么，模型也不会再提，任务就此搁置。
   * 现在只有**已有终态**的计划才收起：
   *   - 全部 done / 全部 dropped → 收（位置还给输入框）
   *   - 用户点过「放弃剩余」→ 收（记在 abandonedPlanKey 里）
   *   - 其余没做完的 → 留着，并由卡片给出「继续执行 / 放弃剩余」两个出口
   */
  const planProgress = useMemo(() => {
    if (!planProgressEnabled) return null;
    const progress = livePlan ?? planFromMessages(messages, { sinceLastUser: true });
    if (!progress) return null;
    if (agentRunning || canExecutePlan) return progress;
    if (isPlanSettled(progress)) return null;
    if (abandonedPlanKey && abandonedPlanKey === planKey(progress)) return null;
    return progress;
  }, [
    messages,
    livePlan,
    planProgressEnabled,
    agentRunning,
    canExecutePlan,
    abandonedPlanKey,
  ]);

  /** 「继续执行」：还剩什么就让它接着做，不重述整份计划。 */
  const resumePlan = useCallback(() => {
    if (agentRunning) return;
    if (canExecutePlan) {
      void commands.handleExecutePlan();
      return;
    }
    const remaining = planProgress ? planRemainingSteps(planProgress) : [];
    const titles = remaining.map((step) => step.title).join("、");
    void commands.handleSend(
      titles ? `继续执行计划里剩下的步骤：${titles}` : "继续执行计划里剩下的步骤",
    );
  }, [agentRunning, canExecutePlan, commands, planProgress]);

  /** 「放弃剩余」：把这张卡结算掉，不再挡住输入框。 */
  const abandonPlan = useCallback(() => {
    if (!planProgress) return;
    setAbandonedPlanKey(planKey(planProgress));
  }, [planProgress]);

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
    planProgress,
    planProgressEnabled,
    resumePlan,
    abandonPlan,
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
    compactionNotice,
    clearCompactionNotice,
    displayModel,
    currentModel,
    sceneState,
    sessionStats,
    sessionActivity,
    /** 手动重试会话加载（错误卡片上的「重试」按钮）。 */
    loadSession,
    agentPhase,
    toolEndTick,
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
    handleRetryDelivery: commands.handleRetryDelivery,
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
    handleUpdateFollowUp,
    handleExpediteFollowUp,
    handleAbortCompaction: commands.handleAbortCompaction,
    handleToolPresetChange,
    handleThinkingLevelChange,
    connectEvents,
    reconnectEvents,
    getLastAgentEventAt,
    getLastRealAgentEventAt,
    connectionStatus,
    reconnectAttempts,
  };
}
