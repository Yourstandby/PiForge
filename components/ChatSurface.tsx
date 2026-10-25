"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ArrowDown, CheckCircle2, ListTodo } from "lucide-react";
import type { AgentMessage, SessionInfo, SessionTreeNode } from "@/lib/types";
import type { ContextBudget } from "@/lib/pi-types";
import { useAgentSession } from "@/hooks/useAgentSession";
import { useSmoothTypewriter } from "@/hooks/useSmoothTypewriter";
import { useAudio } from "@/hooks/useAudio";
import { useHostHealth } from "@/hooks/useHostHealth";
import { estimateContextTokens, resolveTokenGuards, type TokenGuardKind } from "@/lib/token-guard";
import { TokenGuardBanner } from "./TokenGuardBanner";
import { useSessionSplitHint } from "@/hooks/useSessionSplitHint";
import { useSessionScope } from "@/hooks/useSessionScope";
import { conversationToMarkdown } from "@/lib/conversation-markdown";
import { branchNodesToTree, buildBranchSwitchMap } from "@/lib/session-branches-view";
import { buildImagineMessage } from "@/lib/imagine-command";
import { BranchCloneModal, type BranchCloneMode } from "./BranchCloneModal";
import { BranchNavigator } from "./BranchNavigator";
import { visibleErrorMessage } from "@/lib/ui-error";
import { messageText } from "@/lib/message-content";
import { collectRunningTools } from "@/lib/running-tools";
import { useStickyRunningTools } from "@/hooks/useStickyRunningTools";
import { estimateTokens, setLiveUsage } from "@/lib/live-usage";
import { Composer } from "./Composer";
import { ExtensionUiDialog } from "./ExtensionUiDialog";
import { ModalSurface } from "./ModalSurface";
import { RunningToolsBadge } from "./RunningToolsBadge";
import { StatusBar, type ThinkingLevel } from "./StatusBar";
import { UsageStrip } from "./UsageStrip";
import { useUpstreamUsage } from "@/hooks/useUpstreamUsage";
import { buildTranscriptTurns, Transcript } from "./Transcript";
import { savedScrollTop } from "@/lib/chat-scroll-memory";
import { TranscriptNav } from "./TranscriptNav";
import { WatchdogSessionProvider } from "./watchdog/WatchdogProvider";

const DONE_SUMMARY_LIMIT = 1200;

/** 最后一条 assistant 的纯文本（截断），用于「任务结束」提示卡。 */
function lastAssistantText(messages: AgentMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const trimmed = messageText(message).trim();
    if (!trimmed) continue;
    return trimmed.length > DONE_SUMMARY_LIMIT
      ? `${trimmed.slice(0, DONE_SUMMARY_LIMIT)}…`
      : trimmed;
  }
  return undefined;
}

interface Props {
  session: SessionInfo | null;
  newSessionCwd: string | null;
  draft: string;
  modelsRefreshKey?: number;
  onDraftChange: (value: string) => void;
  onSessionCreated: (session: SessionInfo) => void;
  onSessionForked?: (newSessionId: string) => void;
  /** Auto title / rename landed; ask the sidebar to refetch. */
  onSessionRenamed?: () => void;
  /** Open a file reference from the transcript in the file viewer. */
  onOpenFile?: (filePath: string, fileName: string, line?: number) => void;
  /**
   * False while this pane sits in a background session tab. Global shortcuts
   * (Esc = abort) must only fire for the tab the user is looking at.
   */
  active?: boolean;
  /** `/new` slash command: start a fresh session in the current project. */
  onNewSession?: () => void;
  /**
   * 上报本标签的实时状态，供标签栏显示状态指示灯。
   * running = 正在生成/调用工具；waiting = 需要用户处理；idle = 空闲。
   */
  onActivityChange?: (activity: "idle" | "running" | "waiting", summary?: string) => void;
  /** Insert a rendered Markdown code block into the composer. */
  onInsertCode?: (code: string, language?: string) => void;
  /** File currently open in the right panel; empty when nothing is open. */
  applyTargetName?: string | null;
  /** Ask the workbench to apply a code block to that file (shows a confirm dialog). */
  onApplyCode?: (code: string, language?: string) => void;
  /** Open the repository Git Diff pane in the right panel. */
  onOpenGitDiff?: () => void;
}

/**
 * Owns the remount key used to reload a canonical transcript from disk.
 *
 * A brand-new session's first prompt is dispatched by POST /api/agent/new
 * *before* the SSE stream can attach, so a fast model can finish the whole
 * turn before we subscribe and agent_end is never observed. Polling the
 * server's running flag closes that gap (and any dropped-event gap) without
 * touching the shared send logic.
 */
/** 对话导航用：只取用户消息的纯文本（折叠空白，前 20 字 + 省略号）。 */
function navPreview(message: AgentMessage): string {
  const raw = messageText(message, { separator: " " });
  // 兜底清洗：即使文本源里混入了角色标签或操作按钮文字，也一律剔除
  const text = raw
    .replace(/\s+/g, " ")
    .replace(/(?:^|\s)(?:你|PiForge|复制|已复制|复制这段内容|分支|派生|创建中…)(?=\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // 简略列表单行截断，深色气泡里最多展示 3–4 行
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** 粗估单价（USD / token），只用于流式期间的实时跳动，结算仍以真实 usage 为准。 */
const LIVE_COST_PER_TOKEN = 0.000004;

/** 右侧导航的刻度数量上限：永远是 9 个（DeepSeek 式「动态滚动窗口」）。 */
/** 上下文徽章：120_000 → "120.0k"，窗口整千不补小数。 */
function formatContextTokens(tokens: number): string {
  return tokens >= 1_000 ? `${(tokens / 1_000).toFixed(1)}k` : String(tokens);
}

function formatContextCeiling(ceiling: number): string {
  if (ceiling < 1_000) return String(ceiling);
  const k = ceiling / 1_000;
  return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
}

/** 环形描边色：同一份阈值，只换颜色不换判定。 */
function contextBudgetStroke(level: ContextBudget["level"]): string {
  if (level === "critical") return "#DC2626";
  if (level === "warn") return "#D97706";
  return "#94A3B8";
}

/** 迷你环的半径 / 周长：14px 视觉尺寸，笔画 2px。 */
const CONTEXT_RING_RADIUS = 5;
const CONTEXT_RING_CIRCUMFERENCE = 2 * Math.PI * CONTEXT_RING_RADIUS;

/**
 * 上下文占用指示器：只画一个 14px 的环，不写任何文字。
 *
 * 分母 = 模型真实上下文窗口（Host 侧 `describeContextBudget` 算好），与输入框
 * 下方那行「上下文 x% / 窗口」同源：环走满就是真的装满窗口。60% 变黄、
 * 85% 变红并配脉冲，同时单独弹一条“建议手动压缩”的提醒。
 */
function ContextRing({ budget, compacting }: { budget: ContextBudget; compacting?: boolean }) {
  const filled = Math.max(0, Math.min(1, budget.ratioToCeiling));
  const stroke = contextBudgetStroke(budget.level);
  /** 悬停只给人话；精确数字留给屏幕阅读器（视觉用户不需要 8.8k/48k 这种单位）。 */
  const precise =
    budget.tokens === null
      ? "用量未知"
      : `上下文 ${formatContextTokens(budget.tokens)} / 窗口 ${formatContextCeiling(budget.ceiling)}`;
  return (
    <span
      className={`inline-flex items-center ${budget.overshoot ? "context-ring-alert" : ""}`}
      title={budget.hint}
      aria-label={`${budget.hint}（${precise}）`}
      role="img"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 14 14"
        className={compacting ? "animate-spin" : undefined}
        aria-hidden="true"
      >
        <circle cx="7" cy="7" r={CONTEXT_RING_RADIUS} fill="none" stroke="#E2E8F0" strokeWidth="2" />
        <circle
          cx="7"
          cy="7"
          r={CONTEXT_RING_RADIUS}
          fill="none"
          stroke={stroke}
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={`${(filled * CONTEXT_RING_CIRCUMFERENCE).toFixed(2)} ${CONTEXT_RING_CIRCUMFERENCE.toFixed(2)}`}
          transform="rotate(-90 7 7)"
        />
      </svg>
    </span>
  );
}

const MAX_NAV_TICKS = 9;
/** 回弹后蓝条落回的位置：第 5 格（0 基下标 4）。 */
const NAV_WINDOW_CENTER = Math.floor(MAX_NAV_TICKS / 2);

export function ChatSurface(props: Props) {
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((key) => key + 1), []);
  return <ChatSession key={reloadKey} {...props} onReload={reload} />;
}

function ChatSession({
  session,
  newSessionCwd,
  draft,
  modelsRefreshKey,
  onDraftChange,
  onSessionCreated,
  onSessionForked,
  onSessionRenamed,
  onOpenFile,
  onNewSession,
  onInsertCode,
  applyTargetName,
  onApplyCode,
  onOpenGitDiff,
  onActivityChange,
  active = true,
  onReload,
}: Props & { onReload: () => void }) {
  const { soundEnabled, onSoundToggle, playDoneSound } = useAudio();

  // Branch tree state — the hook owns the data, BranchNavigator renders it.
  const [branchTree, setBranchTree] = useState<SessionTreeNode[]>([]);
  const [branchLeafId, setBranchLeafId] = useState<string | null>(null);
  const branchLeafChangeRef = useRef<((leafId: string | null) => void) | null>(null);
  const [branchModal, setBranchModal] = useState<{
    isOpen: boolean;
    mode: BranchCloneMode;
    targetEntryId?: string;
  }>({ isOpen: false, mode: "branch" });

  const handleBranchDataChange = useCallback(
    (
      tree: SessionTreeNode[],
      activeLeafId: string | null,
      onLeafChange: (leafId: string | null) => void,
    ) => {
      setBranchTree(tree);
      setBranchLeafId(activeLeafId);
      branchLeafChangeRef.current = onLeafChange;
    },
    [],
  );

  // 会话加载失败时的优雅重试：手动点「重试」+ 可重试错误自动退避重试。
  const [retrying, setRetrying] = useState(false);
  const autoRetryRef = useRef(0);

  // 全局瞬时提示（压缩结果 / 引擎掉线 / 发送失败共用）。
  const [compactToast, setCompactToast] = useState<{ ok: boolean; text: string } | null>(null);

  const chat = useAgentSession({
    session,
    newSessionCwd,
    modelsRefreshKey,
    active,
    onSessionCreated,
    onSessionForked,
    onBranchDataChange: handleBranchDataChange,
    onAgentEnd: playDoneSound,
    onSessionRenamed: () => onSessionRenamed?.(),
    onNewSession,
    // 发送失败不能静默：气泡留在原地却什么都不发生，看起来就是「输入没反应」。
    onPromptError: (message) => setCompactToast({ ok: false, text: message }),
  });

  const currentModel = chat.displayModel ?? null;
  const {
    agentRunning: escAgentRunning,
    extensionUiRequest: escExtensionUi,
    trustPrompt: escTrustPrompt,
    handleAbort: handleEscAbort,
  } = chat;

  // 标签状态指示灯：等待用户处理 > 运行中 > 空闲。只在变化时上报。
  const needsUser = Boolean(escExtensionUi || escTrustPrompt || chat.canExecutePlan);
  const activity = needsUser ? "waiting" : escAgentRunning ? "running" : "idle";
  const onActivityChangeRef = useRef(onActivityChange);
  onActivityChangeRef.current = onActivityChange;
  const messagesRef = useRef(chat.messages);
  messagesRef.current = chat.messages;
  const previousActivityRef = useRef(activity);
  useEffect(() => {
    const previous = previousActivityRef.current;
    previousActivityRef.current = activity;
    // 忙 → 空闲视为一轮结束：带上最后一条 assistant 文本，供完成提示卡预览。
    const finished = (previous === "running" || previous === "waiting") && activity === "idle";
    if (finished) {
      // 一轮任务结束：右栏如果被 Agent 的浏览器临时占用，可以还回给用户了。
      window.dispatchEvent(new Event("piforge:agent-idle"));
    }
    onActivityChangeRef.current?.(activity, finished ? lastAssistantText(messagesRef.current) : undefined);
  }, [activity]);

  // Esc = hard interrupt while the agent is generating. Menus/dialogs consume
  // Escape first via preventDefault, so this only fires when nothing else did.
  // Background session tabs stay mounted, so gate on `active` to keep one
  // keystroke from aborting every running tab.
  useEffect(() => {
    if (!escAgentRunning || !active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      if (escExtensionUi || escTrustPrompt) return;
      event.preventDefault();
      void handleEscAbort();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [escAgentRunning, escExtensionUi, escTrustPrompt, handleEscAbort, active]);

  // --- Manual context compaction -------------------------------------------
  // The summarising itself is pi's own `compact` command (POST → rpc-manager):
  // we only ask for confirmation and report how many tokens came back.
  const [compactConfirmOpen, setCompactConfirmOpen] = useState(false);

  // Engine liveness: reuse the existing transient toast so the UI layout is
  // unchanged, and disable sending while the host is not ready so a message
  // cannot silently disappear during a reconnect.
  const hostHealth = useHostHealth();
  const hostWasDown = useRef(false);
  useEffect(() => {
    const down = hostHealth.state === "reconnecting" || hostHealth.state === "offline";
    if (down && !hostWasDown.current) {
      hostWasDown.current = true;
      setCompactToast({ ok: false, text: hostHealth.message });
    } else if (hostHealth.state === "ready" && hostWasDown.current) {
      hostWasDown.current = false;
      setCompactToast({ ok: true, text: "后台引擎已恢复" });
    }
  }, [hostHealth.state, hostHealth.message]);

  /**
   * 流式期间才关掉背景节流。
   *
   * 0.9.0 为了"后台不降帧"在 BrowserWindow 里全局 `backgroundThrottling: false`，
   * 代价是空闲窗口也按 60fps 跑装饰动画（实测空闲渲染进程 105% CPU）。
   * 现在默认节流开启，只有 agent 真的在跑时才临时关掉（打字机的 rAF 需要按帧走）。
   */
  useEffect(() => {
    const api = (window as { electronAPI?: { setStreamingThrottle?: (enabled: boolean) => void } })
      .electronAPI;
    api?.setStreamingThrottle?.(Boolean(chat.agentRunning));
    return () => api?.setStreamingThrottle?.(false);
  }, [chat.agentRunning]);

  useEffect(() => {
    if (!compactToast) return;
    const timer = setTimeout(() => setCompactToast(null), 4200);
    return () => clearTimeout(timer);
  }, [compactToast]);

  const canCompact = Boolean(session?.id) && !chat.agentRunning && !chat.isCompacting;

  /**
   * 上下文提醒（自动压缩已下线）：只剩提醒 + 手动压缩。
   * 分母是模型真实窗口（Host 侧算好），所以 85% 才亮，不会再动不动就红。
   * 关掉之后要等用量再涨 5% 才重弹，避免同一个读数反复骚扰。
   */
  const [ctxReminderMutedAt, setCtxReminderMutedAt] = useState<number | null>(null);
  const ctxBudget = chat.contextBudget;
  const ctxReminder =
    ctxBudget && ctxBudget.tokens !== null && (ctxBudget.level === "critical" || ctxBudget.overshoot)
      ? ctxBudget
      : null;
  const ctxReminderVisible =
    Boolean(ctxReminder) &&
    !chat.isCompacting &&
    (ctxReminderMutedAt === null ||
      (ctxReminder?.tokens ?? 0) >= ctxReminderMutedAt + Math.max(1, Math.round((ctxReminder?.ceiling ?? 0) * 0.05)));

  const handleApplyCode = useCallback(
    (code: string, language?: string) => {
      if (!applyTargetName) {
        setCompactToast({ ok: false, text: "右侧没有打开的文件，请先在文件树中打开一个文件" });
        return;
      }
      onApplyCode?.(code, language);
    },
    [applyTargetName, onApplyCode],
  );

  /** Ctrl/Cmd+Shift+C: whole conversation as Markdown on the clipboard. */
  const copyConversation = useCallback(async () => {
    const markdown = conversationToMarkdown(chat.messages);
    try {
      await navigator.clipboard.writeText(markdown);
      setCompactToast({ ok: true, text: "对话已复制" });
    } catch {
      setCompactToast({ ok: false, text: "复制失败：剪贴板不可用" });
    }
  }, [chat.messages]);

  /** Ctrl/Cmd+K: same reset as the /clear slash command. */
  const clearConversation = useCallback(() => {
    if (chat.agentRunning) {
      setCompactToast({ ok: false, text: "正在生成，先按 Esc 中断" });
      return;
    }
    void chat.handleSend("/clear");
    setCompactToast({ ok: true, text: "已清空当前对话视图" });
  }, [chat]);

  // Global (active-tab only) shortcuts. Capture phase so a focused textarea
  // cannot swallow them. Dialogs keep the keyboard to themselves.
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (document.querySelector('[role="dialog"], [aria-modal="true"]')) return;
      if (event.shiftKey && event.key.toLowerCase() === "c") {
        event.preventDefault();
        void copyConversation();
        return;
      }
      if (!event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        clearConversation();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [active, copyConversation, clearConversation]);

  const runCompact = useCallback(async () => {
    setCompactConfirmOpen(false);
    const outcome = await chat.handleCompact();
    if (outcome.ok) {
      const saved =
        outcome.tokensBefore != null && outcome.tokensAfter != null
          ? Math.max(0, outcome.tokensBefore - outcome.tokensAfter)
          : null;
      setCompactToast({
        ok: true,
        text:
          saved && saved > 0
            ? `已压缩历史，释放了 ${saved.toLocaleString("en-US")} Tokens`
            : "已压缩历史",
      });
    } else {
      setCompactToast({ ok: false, text: `压缩失败：${outcome.error}` });
    }
  }, [chat]);
  const availableThinkingLevels = currentModel
    ? (chat.modelThinkingLevels[`${currentModel.provider}:${currentModel.modelId}`] ?? null)
    : null;

  const branchSwitchMap = useMemo(
    () => buildBranchSwitchMap(chat.branches?.nodes ?? []),
    [chat.branches],
  );

  const branchSwitchFor = useCallback(
    (entryId: string) => branchSwitchMap.get(entryId) ?? null,
    [branchSwitchMap],
  );

  /** 分支图优先：它含兄弟分叉，data.tree 只有当前路径。 */
  const navigatorTree = useMemo(() => {
    const nodes = chat.branches?.nodes;
    return nodes && nodes.length > 0 ? branchNodesToTree(nodes) : branchTree;
  }, [chat.branches, branchTree]);

  const handleSwitchBranch = useCallback(
    (leafId: string | null, options?: { summarize?: boolean }) =>
      chat.handleLeafChange(leafId, options),
    [chat],
  );

  /**
   * 会话还在跑（流式回复 / 工具执行）时，宿主会直接拒绝 fork 和切分支：
   * fork 要读一份可能正被追加写的 .jsonl，切分支要移活会话的叶子。
   * 与其点了毫无反应，不如按钮先禁用并说明原因。
   */
  const actionsBlocked = Boolean(chat.agentRunning || chat.streamState.isStreaming);

  /** GitBranch button: fork at this message, prefilling the composer when pi returns text. */
  const handleBranchAt = useCallback(
    async (entryId: string) => {
      const editorText = await chat.handleBranchAt(entryId);
      if (editorText) onDraftChange(editorText);
    },
    [chat, onDraftChange],
  );

  const rawStreaming = chat.streamState.isStreaming ? chat.streamState.streamingMessage : null;
  /**
   * 平滑打字机：上游 chunk 粒度可能极大（一次几百字），这里用 rAF 每帧放 3 个字，
   * 流式结束后 `enabled=false` 会瞬间补齐剩余字符。
   */
  const { message: streaming } = useSmoothTypewriter(
    rawStreaming as { content?: unknown } | null,
    Boolean(rawStreaming),
  );

  /**
   * 开发期流式诊断：每次文本增长都打印 chunk 大小与尾部内容。
   * - 每次几十~一百多字符 → 上游是真流式，打字机按设定节奏铺开；
   * - 每次几百上千字符   → provider 粒度太粗，打字机会自动走"积压 >200 瞬补"分支。
   */
  const lastChunkLenRef = useRef(0);
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const text = messageText(rawStreaming);
    const delta = text.length - lastChunkLenRef.current;
    lastChunkLenRef.current = text.length;
    if (delta > 0) console.log("[SSE Chunk]", delta, text.slice(-80));
  }, [rawStreaming]);
  /**
   * 稳定消息 key（修复"新消息被塞进上一条消息里"的错位）。
   *
   * 旧实现用数组下标当 React key：流式期间若新的 user 消息插进来，后面所有
   * 下标都会平移，React 就会把新 DOM 复用到旧节点上。这里给每条消息对象分配
   * 一个只增不减的稳定 id（WeakMap，对象存活期不变），流式那条永远是同一个
   * 常量 key，因此插入/追加都只会让 React "移动"节点，而不会"错挂"。
   */
  const stableIdRef = useRef(new WeakMap<object, string>());
  const stableIdSeqRef = useRef(0);
  const stableKeyOf = useCallback((message: AgentMessage) => {
    const object = message as unknown as object;
    let key = stableIdRef.current.get(object);
    if (!key) {
      stableIdSeqRef.current += 1;
      key = `msg-${stableIdSeqRef.current}`;
      stableIdRef.current.set(object, key);
    }
    return key;
  }, []);

  const STREAMING_KEY = "__live_stream__";
  /** 流式开始时的插入位置：中途来了新的 user 消息，助手占位也不会被挤到它后面。 */
  const streamingAnchorRef = useRef<number | null>(null);
  if (streaming) {
    if (streamingAnchorRef.current === null) {
      streamingAnchorRef.current = chat.messages.length;
    }
  } else {
    streamingAnchorRef.current = null;
  }

  // 流式最后一条消息合并进列表时保持引用稳定，否则 transcriptNode 的 memo 每帧失效。
  const messages: AgentMessage[] = useMemo(() => {
    if (!streaming) return chat.messages;
    const anchor = Math.min(streamingAnchorRef.current ?? chat.messages.length, chat.messages.length);
    return [
      ...chat.messages.slice(0, anchor),
      streaming as AgentMessage,
      ...chat.messages.slice(anchor),
    ];
  }, [chat.messages, streaming]);

  /** 与 `messages` 严格 1:1 的稳定 key。 */
  const messageKeys: string[] = useMemo(() => {
    const base = chat.messages.map((message) => stableKeyOf(message));
    if (!streaming) return base;
    const anchor = Math.min(streamingAnchorRef.current ?? chat.messages.length, chat.messages.length);
    return [...base.slice(0, anchor), STREAMING_KEY, ...base.slice(anchor)];
  }, [chat.messages, streaming, stableKeyOf]);

  /**
   * 开发期结构自检：每条新消息到达时打印一次顺序 + 是否处于流式。
   * 正常应为 `0:user 1:assistant 2:user …`，流式的那条永远在末尾。
   */
  const streamingFlag = Boolean(streaming);
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    console.debug(
      "[messages]",
      chat.messages.map((message, index) => `${index}:${message.role}`).join(" "),
      "| streaming:",
      streamingFlag ? "appended-tail" : "none",
    );
  }, [chat.messages, streamingFlag]);

  // No session yet + no messages = the hero composer. Once a session is
  // selected (or a first message is queued) switch to the transcript view.
  const retrySessionLoad = useCallback(async () => {
    if (!session || retrying) return;
    setRetrying(true);
    try {
      await chat.loadSession(session.id, true, true);
    } finally {
      setRetrying(false);
    }
  }, [chat, session, retrying]);

  // 可重试错误（HTTP 5xx / 超时 / 管道中断）：1.5s、3s 各自动重试一次，
  // 覆盖「Host 刚起来」「next dev 刚重载」这类瞬时窗口，避免用户手动点。
  const loadSessionRef = useRef(chat.loadSession);
  loadSessionRef.current = chat.loadSession;

  useEffect(() => {
    if (!chat.error || !session) {
      autoRetryRef.current = 0;
      return;
    }
    const retryable = /(HTTP 5\d\d|timed out|Failed to fetch|network|socket|ENOENT|ECONN)/i.test(chat.error);
    // 重试预算从 2 次（≈4.5s）提到 6 次（≈28s）：冷启动时 Host 要 5–20s
    // 才就绪，旧预算在引擎刚起来时就先用完了，用户看到的是"加载失败"而不是
    // "引擎启动中"。首次成功后计数器归零，不影响真正的持续故障。
    if (!retryable || autoRetryRef.current >= 6) return;
    const attempt = autoRetryRef.current + 1;
    const timer = window.setTimeout(() => {
      autoRetryRef.current = attempt;
      void loadSessionRef.current(session.id, false, true);
    }, Math.min(attempt * 2_000, 6_000));
    return () => window.clearTimeout(timer);
  }, [chat.error, session]);

  const showTranscript = messages.length > 0 || session !== null || Boolean(chat.error);
  /** 真·加载失败（没有任何消息可显示）：用极简卡片替代整个对话界面。 */
  const loadFailed = Boolean(chat.error) && messages.length === 0;

  /** 会话作用域：切会话时把上一个会话残留的定时器/观察者一次性清掉。 */
  const scoped = useSessionScope(session?.id ?? null);

  /**
   * Token 护栏（P2-2 / P2-3a）——纯提示，只读 `contextUsage.tokens` 与 `prefixAudit`。
   * 关掉的类型记在本组件里（按会话重置），不写任何持久化状态。
   */
  const [dismissedGuards, setDismissedGuards] = useState<TokenGuardKind[]>([]);
  useEffect(() => {
    setDismissedGuards([]);
  }, [session?.id]);
  // L-B 实验开关：默认 false（与引入前一致），`PIFORGE_SESSION_SPLIT_HINT=1` 才给动作按钮。
  const sessionSplitHint = useSessionSplitHint();
  const tokenGuardHints = useMemo(
    () =>
      resolveTokenGuards({
        flags: { sessionSplitHint },
        // 未运行的会话没有 contextUsage（Host 侧还没有 wrapper）→ 用 transcript 估算。
        contextTokens: chat.contextUsage?.tokens ?? (estimateContextTokens(messages) || null),
        hasMessages: messages.length > 0,
        // 只有真正闲置过的会话才算“恢复”：新会话的 modified 就是刚刚，不会触发。
        lastActivityAt: session?.modified ?? null,
        prefixAudit: chat.prefixAudit,
        dismissed: dismissedGuards,
      }),
    // messages 用于估算上下文（未运行会话没有 contextUsage）；依赖整数组才能跟上内容变化。
    [chat.contextUsage?.tokens, chat.prefixAudit, messages, dismissedGuards, sessionSplitHint, session?.modified],
  );

  /**
   * 恢复费提示只在“刚打开、还没发过消息”那一刻成立：一旦开始跑就收起，
   * 否则它会与“上下文 x% / 窗口”那行一起悬在正在聊的会话里继续误导。
   */
  useEffect(() => {
    if (!chat.agentRunning) return;
    setDismissedGuards((prev) => (prev.includes("resume-cost") ? prev : [...prev, "resume-cost"]));
  }, [chat.agentRunning]);

  // Reconcile with the server when the run ends without us seeing agent_end.
  useEffect(() => {
    if (!chat.agentRunning || !session) return;
    let cancelled = false;
    let idleReads = 0;

    const stop = scoped.setInterval(async () => {
      try {
        const res = await fetch(`/api/agent/${encodeURIComponent(session.id)}`);
        if (!res.ok) return;
        const data = (await res.json()) as { running?: boolean };
        if (cancelled) return;
        if (data.running) {
          idleReads = 0;
          return;
        }
        idleReads += 1;
        if (idleReads >= 2) {
          stop();
          onReload();
        }
      } catch {
        // Keep the current view; a transient poll failure is not fatal.
      }
    }, 2000);

    return () => {
      cancelled = true;
      stop();
    };
  }, [chat.agentRunning, session, onReload, scoped]);

  const scrollRef = useRef<HTMLDivElement>(null);
  /** 底部哨兵：IntersectionObserver 的唯一观测目标（是否贴底只看它）。 */
  const bottomSentinelRef = useRef<HTMLDivElement>(null);
  const composerContainerRef = useRef<HTMLDivElement>(null);
  /** 用户是否已主动上翻（镜像 awayFromBottom，供自动跟随判断用，避免 deps 抖动）。 */
  const awayFromBottomRef = useRef(false);
  /**
   * 「自动跟随」开关：true = 新内容到达时滚到底部。
   * - 用户向上滚轮 → 立刻置 false（绝不把用户拽回去）
   * - 用户滚回底部（距底 < 100px）或点「回到最新」→ 重新置 true
   */
  const followOutputRef = useRef(true);
  /** 距底 <150px 视为"贴底"；只有贴底时才允许自动滚动跟随。 */
  const isNearBottomRef = useRef(true);
  /**
   * 用户主动接管（点击对话区 / 向上滚动）。
   * true 时跳过一切自动贴底，直到用户自己滚回底部或点「回到最新」。
   */
  const userPausedRef = useRef(false);
  /**
   * 用户刚上滚过一次（还没真正回到底部）。
   * 哨兵带 120px 容差，若不锁住，上滚一点点就会被判 intersecting 而拽回底部。
   * 解除点只有一个：measure 里真正距底 < 40px。
   */
  const wheelUpRef = useRef(false);
  /** 输入时保持贴底：仅当用户当前在底部附近（手动上翻后不打扰）。 */
  const stickToBottomIfNear = useCallback(() => {
    if (userPausedRef.current || wheelUpRef.current || !isNearBottomRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  /** 新一轮开始（发送后）：强制跟随——用户刚发消息，期望看到后续回复。 */
  useEffect(() => {
    if (!chat.agentRunning) return;
    userPausedRef.current = false;
    followOutputRef.current = true;
    isNearBottomRef.current = true;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [chat.agentRunning]);

  /** 用户主动向上滚轮 = 明确想离开底部，立刻停止自动跟随。 */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) {
        wheelUpRef.current = true;
        userPausedRef.current = true;
        followOutputRef.current = false;
        isNearBottomRef.current = false;
        needsInitialBottomRef.current = false;
        // 作废「首屏/切会话贴底窗口」：否则开长会话后 1.5s 内每长高一次
        // 都把人拽回底部，手一动就被拉回去，看起来就是上下颠。
        pinBottomUntilRef.current = 0;
        // 取消进行中的平滑滚动，避免惯性把用户拽回底部。
        el.scrollTop = el.scrollTop;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  /** 点击对话区（选中文本、展开工具卡、点链接等）= 用户接管，停止自动跟随。 */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // 只中断进行中的惯性/平滑滚动。**不再**在这里改跟随状态：
    // 点击/选文本后如果没人再滚动，就没有 scroll 事件来恢复，
    // 超长流式输出会永久停住（原来的 bug）。贴底判定交给底部哨兵。
    const onPointerDown = () => {
      el.scrollTop = el.scrollTop;
    };
    el.addEventListener("pointerdown", onPointerDown, { passive: true });
    return () => el.removeEventListener("pointerdown", onPointerDown);
  }, []);

  /**
   * 「是否贴底」的唯一判据：底部哨兵 + IntersectionObserver。
   * 不读 `scrollHeight`（无强制同步布局）、不挂 `scroll` 事件（拖拽时一秒上百次）。
   * - 哨兵离开视野（用户向上翻阅 / 内容把底部顶下去）→ 暂停跟随，绝不拽回；
   * - 哨兵回到容器底部 120px 内 → 恢复跟随。
   * 回调只在跨越阈值时触发，因此「滚轮轻推一下」不会被立刻拽回底部。
   */
  useEffect(() => {
    const el = scrollRef.current;
    const sentinel = bottomSentinelRef.current;
    if (!el || !sentinel || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (!entry) return;
        const atBottom = entry.isIntersecting;
        isNearBottomRef.current = atBottom;
        followOutputRef.current = atBottom;
        // 上滚未回底期间不解除接管、不补写底部（否则一推滚轮就被拽回）。
        if (wheelUpRef.current) return;
        userPausedRef.current = !atBottom;
        if (atBottom) {
          needsInitialBottomRef.current = false;
          // 回到贴底那一刻先补写一次：RO 只在高度变化时回调，
          // 如果内容已停止增长（流结束 / 已渲染完），光靠标志位复位页面不会动，
          // 用户看到的就是「滚到底了也不恢复跟随」。
          const node = scrollRef.current;
          if (node) node.scrollTop = node.scrollHeight;
        }
      },
      { root: el, rootMargin: "0px 0px 120px 0px", threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [showTranscript]);
  /**
   * 「首次打开这个会话，才自动贴底」。
   * 同一个会话（标签页）再次切回来时 `session.id` 不变，这里不会重跑，
   * 用户之前滚到哪就停在哪，不会被强制拉到底部。
   */
  const needsInitialBottomRef = useRef(true);
  /** 标签切走时记住滚动位置；切回时恢复（离开时贴底则继续贴底）。 */
  const savedScrollRef = useRef<{ top: number; atBottom: boolean } | null>(null);
  /**
   * 滚动过程中持续记录的位置。切标签时容器可能已经是 `display:none`
   * （scrollTop 读出来是 0），只能靠这份记录；没有它就会"切回来停在第一条消息"。
   */
  const lastKnownTopRef = useRef(0);
  const wasActiveRef = useRef(true);
  /**
   * 还没挂到屏幕上的标签（Workbench 用 display:none 隐藏非活动面板）：
   * 隐藏时 `clientHeight === 0`，此时写 scrollTop 等于写 0，切回来就会停在
   * 最开头。所以贴底改走「记账」：等面板真正可见那一帧再补。
   */
  const pendingBottomRef = useRef(false);
  /** 首次进入 / 切会话后的一小段时间内，内容继续长高也要贴住底部。 */
  const pinBottomUntilRef = useRef(0);
  const pinToBottom = useCallback((el: HTMLDivElement | null, settleMs = 0) => {
    if (!el) return;
    if (el.clientHeight === 0) {
      pendingBottomRef.current = true;
      return;
    }
    pendingBottomRef.current = false;
    if (settleMs > 0) pinBottomUntilRef.current = performance.now() + settleMs;
    el.scrollTop = el.scrollHeight;
  }, []);

  /**
   * 「用户亲手发消息 / 点回到最新」：无条件恢复跟随并贴底。
   *
   * 与自动跟随分开：自动跟随只看是否贴底（用户上翻就停），
   * 而发送是明确意图 —— 哪怕翻到几屏之前，也要立刻跳回最新。
   */
  const resumeFollow = useCallback(() => {
    userPausedRef.current = false;
    followOutputRef.current = true;
    isNearBottomRef.current = true;
    needsInitialBottomRef.current = false;
    pinToBottom(scrollRef.current, 1500);
  }, [pinToBottom]);

  /**
   * 异步撑高（markdown 高亮、代码块、图片解码）会把"刚贴好底"的内容顶上去，
   * 一次 scrollTop 赋值不够。首屏贴底窗口内，内容每长高一次就再贴一次；
   * 窗口结束后交还给原来的「贴底才跟随」逻辑，不动用户手动上翻的位置。
   */
  useEffect(() => {
    const el = scrollRef.current;
    const inner = el?.firstElementChild;
    if (!el || !inner || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      // 跟不跟随只看 IntersectionObserver 维护的 followOutputRef。
      if (!followOutputRef.current) return;
      if (performance.now() > pinBottomUntilRef.current) return;
      const node = scrollRef.current;
      if (!node || node.clientHeight === 0) return;
      node.scrollTop = node.scrollHeight;
    });
    observer.observe(el);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [showTranscript]);

  /**
   * 切换标签页的滚动记忆。注意：实际滚动容器是本地 `scrollRef`
   * （useChatScroll 的 setScrollContainer 从未绑定，别处改动不会生效）。
   * 离开时记下位置，回来时多帧恢复（图片/代码块异步擑高，一次恢复会被 clamp）；
   * 离开时在底部则继续贴底。首次进入不恢复，交给 needsInitialBottom 贴底。
   */
  useLayoutEffect(() => {
    const wasActive = wasActiveRef.current;
    wasActiveRef.current = active;
    const el = scrollRef.current;
    if (!el) return;
    if (!active) {
      // 隐藏后再读 scrollTop 一定是 0：优先用滚动过程中记录的位置。
      savedScrollRef.current = {
        top: savedScrollTop(el.scrollTop, el.clientHeight, lastKnownTopRef.current),
        atBottom: isNearBottomRef.current,
      };
      return;
    }
    if (wasActive) return;
    if (!savedScrollRef.current) {
      // 隐藏期间加载完的历史：切回来那一刻补一次贴底（否则停在最开头）。
      if (!pendingBottomRef.current) return;
      const pin = () => pinToBottom(el, 1500);
      pin();
      requestAnimationFrame(pin);
      const timer = window.setTimeout(pin, 120);
      return () => window.clearTimeout(timer);
    }
    const { top, atBottom } = savedScrollRef.current;
    lastKnownTopRef.current = top;
    followOutputRef.current = atBottom;
    isNearBottomRef.current = atBottom;
    const restore = () => {
      el.scrollTop = atBottom ? el.scrollHeight : top;
    };
    restore();
    requestAnimationFrame(restore);
    const t1 = window.setTimeout(restore, 120);
    const t2 = window.setTimeout(restore, 400);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [active, pinToBottom]);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    needsInitialBottomRef.current = true;
    followOutputRef.current = true;
    isNearBottomRef.current = true;
    pinToBottom(el, 1500);
  }, [session?.id, pinToBottom]);

  /** 开始输入（draft 变化）：在底部附近则保持贴底。 */
  useEffect(() => {
    if (!isNearBottomRef.current) return;
    const raf = requestAnimationFrame(stickToBottomIfNear);
    return () => cancelAnimationFrame(raf);
  }, [draft, stickToBottomIfNear]);

  /** 输入框高度变化（多行 / 附件）时同步贴底，避免内容被顶出视野。 */
  useEffect(() => {
    const node = composerContainerRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (isNearBottomRef.current) stickToBottomIfNear();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [stickToBottomIfNear]);

  /** 首次内容到位后（异步 markdown/高亮可能还在撑高）再贴一次，然后关闭"首屏贴底"。 */
  useLayoutEffect(() => {
    if (messages.length === 0) return;
    const el = scrollRef.current;
    // 加载期没有滚动容器（渲染的是"加载会话…"），这时不能把"已贴底"标记清掉，
    // 否则容器挂上来的那一帧没人接手 —— 用户看到的就是"停在最开头"。
    if (!el) return;
    if (!needsInitialBottomRef.current) return;
    pinToBottom(el, 1500);
    needsInitialBottomRef.current = false;
  }, [messages.length, showTranscript, pinToBottom]);

  /**
   * 内容高度变化（流式文本、代码高亮、图片、折叠动画）时贴底：
   * 跟随与否**只**由 IntersectionObserver 维护的 followOutputRef 决定，这里不做标志位判断；
   * 观察目标每帧重新解析，避免 React 换了内容层后盯着已经脱离文档的旧节点。
   */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !showTranscript || typeof ResizeObserver === "undefined") return;
    // 内容层节点可能被 React 换掉（加载占位 → 真正的消息层、会话切换），
    // 一旦盯着已经脱离文档的旧节点，RO 就再也不会回调（这是「彻底卡死」的成因）。
    let observed: Element | null = null;
    const writeBottom = () => {
      const node = scrollRef.current;
      if (!node) return;
      // 越界值会被浏览器夹到底部：等价于「贴底」，且不读布局。
      node.scrollTop = node.scrollHeight;
    };
    const observer = new ResizeObserver(() => {
      const content = el.firstElementChild;
      if (content && content !== observed) {
        if (observed) observer.unobserve(observed);
        observer.observe(content);
        observed = content;
      }
      // 跟随与否只问 IntersectionObserver；这里不做标志位判断，高度一变就排一帧写到底。
      if (!followOutputRef.current) return;
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(writeBottom);
      else window.setTimeout(writeBottom, 16);
    });
    observer.observe(el);
    const content = el.firstElementChild;
    if (content) {
      observer.observe(content);
      observed = content;
    }
    return () => observer.disconnect();
  }, [showTranscript]);

  /**
   * 同步兜底：React 提交 DOM 与 RO 回调之间有一帧级时间差，
   * 长文本 + 代码高亮这种「先渲染后撑高」的情况可能漏滚。
   * 每次流式快照落地后再补写两次（微任务 + 宏任务各一次），只写不读。
   * 是否该跟随仍由 followOutputRef 决定，上翻时这里什么都不做。
   */
  useEffect(() => {
    if (!chat.agentRunning) return;
    const writeBottom = () => {
      const node = scrollRef.current;
      if (!node || !followOutputRef.current) return;
      node.scrollTop = node.scrollHeight;
    };
    if (typeof queueMicrotask === "function") queueMicrotask(writeBottom);
    else void Promise.resolve().then(writeBottom);
    const timer = window.setTimeout(writeBottom, 0);
    return () => window.clearTimeout(timer);
  }, [chat.streamState.streamingMessage, chat.agentRunning]);

  /**
   * bash 执行期间只在终端图标上点亮一个小绿点（不自动切 Tab、不抢当前视图）。
   * 终端内容本来就由 host 的 desktop-terminal-extension 推流，用户想看图时自己点。
   */
  useEffect(() => {
    const phase = chat.agentPhase;
    const running =
      phase?.kind === "running_tools" && phase.tools.some((tool) => tool.name === "bash");
    window.dispatchEvent(new CustomEvent("piforge:terminal-running", { detail: running }));
  }, [chat.agentPhase]);

  // ------------------------------------------------------------------ 对话导航
  /**
   * 刻度数据源 = 已落盘的 `chat.messages`（**不含流式那条**），**不读 DOM**。
   * 两个理由：
   * 1. 以前是扫 `[data-turn-role="user"]`，一旦「首屏只挂载最近 20 轮」生效，
   *    更早的轮次不在 DOM 里，长会话就只剩零星几个刻度；
   * 2. 这份列表同时作为 `precomputedTurns` 传给 Transcript，必须是冻结的历史，
   *    否则 `TurnRow` 的 memo 会被每帧重建的 turn 对象整行打穿。
   * 流式那一条由 Transcript 自己从 `streamingMessage` 追加（`#turn-N` 仍对齐）。
   */
  const visibleTurns = useMemo(
    () => (showTranscript ? buildTranscriptTurns(chat.messages) : []),
    [showTranscript, chat.messages],
  );

  /** 每个用户轮次 → 该轮在 turns 数组中的下标（跳转锚点 `id="turn-N"`）。 */
  const userTurns = useMemo(() => {
    const out: Array<{ turnIndex: number; text: string }> = [];
    visibleTurns.forEach((turn, turnIndex) => {
      if (turn.role !== "user") return;
      const message = chat.messages[turn.messageIndex];
      out.push({ turnIndex, text: message ? navPreview(message) : turn.text });
    });
    return out;
  }, [visibleTurns, chat.messages]);

  /** 当前所在轮次（turns 下标）。ref 让滚动监听不必因状态变化重新绑定。 */
  const [activeTurn, setActiveTurn] = useState(0);
  const activeTurnRef = useRef(0);

  /** 当前滚动位置在 userTurns 里的位置（最后一个 turnIndex ≤ activeTurn）。 */
  const activeUserPos = useMemo(() => {
    let position = -1;
    for (let index = 0; index < userTurns.length; index += 1) {
      if (userTurns[index].turnIndex <= activeTurn) position = index;
      else break;
    }
    return position < 0 ? 0 : position;
  }, [userTurns, activeTurn]);

  /**
   * 滑动窗口（Minimap / DeepSeek 式吸附）：9 个刻度永远是一段连续轮次。
   *
   * `startOffset = clamp(activePos - 4, 0, total - 9)`
   *  - 在底部：startOffset 撞到 total-9，高亮落在第 9 格（最下方）；
   *  - 往上滚：窗口先不动，高亮逐格上移（9→8→7…，上方灰刻度被"消耗"）；
   *  - 高亮走到第 5 格（中间）后继续上滚：窗口整体上移一格补新刻度，高亮保持居中；
   *  - 到对话最顶部：startOffset 被 0 夹住，窗口无法再平移，高亮停在第 1 格。
   * 向下滚动完全对称。两端靠 clamp 兜住，绝不会溢出这 9 格。
   */
  /**
   * 「触发式回弹」滑动窗口：先稳住边缘，越界一格才翻页。
   *  - 蓝条走到第 1 格（pos === start）时窗口**不动**，稳稳停在最上方；
   *  - 只有再往上、激活了更早的一条（pos < start）才翻窗，蓝条落到第 5 格；
   *  - 底部对称：pos === start+8 稳住，pos > start+8 才翻窗落到第 5 格；
   *  - 到整个对话首/末条（无处可补）时窗口停平，蓝条停在首末格不再回弹。
   */
  const [navStartOffset, setNavStartOffset] = useState(0);
  const navStartRef = useRef(0);
  const navInitializedRef = useRef(false);

  useEffect(() => {
    const total = userTurns.length;
    if (total === 0) {
      navInitializedRef.current = false;
      navStartRef.current = 0;
      setNavStartOffset(0);
      return;
    }
    const maxStart = Math.max(0, total - MAX_NAV_TICKS);

    // 首次拿到数据：窗口直接落在底部（最新一轮占第 9 格）
    if (!navInitializedRef.current) {
      navInitializedRef.current = true;
      navStartRef.current = maxStart;
      setNavStartOffset(maxStart);
      return;
    }

    const start = Math.min(navStartRef.current, maxStart);
    let next = start;
    // 严格越界才回弹（站在第 1 / 第 9 格时保持不动）
    const overflowTop = activeUserPos < start;
    const overflowBottom = activeUserPos > start + MAX_NAV_TICKS - 1;
    if (overflowTop && start > 0) {
      next = Math.max(0, Math.min(maxStart, activeUserPos - NAV_WINDOW_CENTER));
    } else if (overflowBottom && start < maxStart) {
      next = Math.max(0, Math.min(maxStart, activeUserPos - NAV_WINDOW_CENTER));
    }

    if (next !== navStartRef.current) {
      navStartRef.current = next;
      setNavStartOffset(next);
    }
  }, [activeUserPos, userTurns.length]);

  /**
   * 实际生效的窗口起点：初始化完成前直接贴底（最新一轮在第 9 格），
   * 这样会话刚加载时不会先闪一帧「从顶部开始」的窗口。
   */
  const navWindowStart = useMemo(() => {
    const maxStart = Math.max(0, userTurns.length - MAX_NAV_TICKS);
    return navInitializedRef.current ? Math.min(navStartOffset, maxStart) : maxStart;
  }, [userTurns.length, navStartOffset]);

  const navTicks = useMemo(
    () => userTurns.slice(navWindowStart, navWindowStart + MAX_NAV_TICKS),
    [userTurns, navWindowStart],
  );

  /** 全量条目：悬浮卡片要能翻到**所有**历史提问（不再受 9 条窗口限制）。 */
  const navAllItems = useMemo(
    () => userTurns.map((tick) => ({ id: `turn-${tick.turnIndex}`, text: tick.text })),
    [userTurns],
  );
  /** 轨道 9 个刻度落在全量列表里的下标。 */
  const navTickPositions = useMemo(
    () =>
      navTicks
        .map((tick) => userTurns.findIndex((item) => item.turnIndex === tick.turnIndex))
        .filter((index) => index >= 0),
    [navTicks, userTurns],
  );

  const [awayFromBottom, setAwayFromBottom] = useState(false);

  /** 蓝条位置 = 当前轮次在窗口内的下标（0=最上，8=最下），不再提前居中。 */
  const activeTickIndex = useMemo(() => {
    if (userTurns.length === 0) return -1;
    return Math.min(MAX_NAV_TICKS - 1, Math.max(0, activeUserPos - navWindowStart));
  }, [userTurns.length, activeUserPos, navWindowStart]);

  /** 待跳转目标：目标轮次可能还没挂载，先请 Transcript 把它拉进渲染窗口。 */
  const [pendingJump, setPendingJump] = useState<{ turnIndex: number; token: number } | null>(null);

  useEffect(() => {
    if (!pendingJump) return;
    const el = scrollRef.current;
    if (!el) return;
    let frame = 0;
    let raf = 0;
    const attempt = () => {
      const target = el.querySelector<HTMLElement>(`#turn-${pendingJump.turnIndex}`);
      if (target) {
        const scrollMargin = parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
        const align = () => {
          const delta =
            target.getBoundingClientRect().top - el.getBoundingClientRect().top - scrollMargin;
          if (Math.abs(delta) >= 0.5) el.scrollTop += delta;
          return delta;
        };
        // 首帧对齐后，再补一帧：`content-visibility:auto` 的离屏轮次用估算高度占位，
        // 真正渲染出来后会二次回流，需要再校准一次才不会"差一截"。
        if (Math.abs(align()) >= 0.5) requestAnimationFrame(align);
        setPendingJump(null);
        return;
      }
      // 等 Transcript 把目标轮次挂上来（最多撑 8 帧）
      if (frame++ < 8) raf = requestAnimationFrame(attempt);
      else setPendingJump(null);
    };
    raf = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(raf);
  }, [pendingJump]);

  /** 点击刻度 / 列表项：跳到对应轮次（必要时先展开历史）。 */
  const jumpToTurn = useCallback(
    (index: number) => {
      const tick = userTurns[index];
      if (!tick) return;
      setPendingJump((previous) => ({ turnIndex: tick.turnIndex, token: (previous?.token ?? 0) + 1 }));
      setActiveTurn(tick.turnIndex);
    },
    [userTurns],
  );

  /**
   * 「回到最新对话」按钮走瞬移（直接写 scrollTop，无平滑动画）；
   * 键盘快捷键仍可传 "smooth"。瞬移同样会触发 scroll 事件，
   * 右侧导航的窗口回弹/蓝条滑动因此能正常播放。
   */
  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scrollRef.current;
    if (!el) return;
    if (behavior === "smooth") {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, []);

  // 滚动时：高亮当前所在回合 + 判断是否离开底部（只统计已挂载的轮次）。
  // 拖拽滚动条会连续派发上百个 scroll 事件，这里用 rAF 合并成「每帧最多一次」，
  // 并且只在值真的变化时才 setState，避免滚动期间高频重渲染掉帧。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    let lastAway: boolean | null = null;
    let lastActive = Number.NaN;

    const measure = () => {
      raf = 0;
      // 只在能真正量出高度时记录：隐藏面板的 scrollTop 恒为 0，记它等于没记。
      if (el.clientHeight > 0) lastKnownTopRef.current = el.scrollTop;
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      // 距底 <150px 视为贴底；只有此时才允许自动跟随
      const near = distance < 150;
      isNearBottomRef.current = near;
      // 已经上翻（wheelUp）就不要在这里重新武装跟随：哨兵只有 120px 容差，
      // 这个 150px 的判定会把刚上翻的用户重新按回底部，滚一下被按回一次。
      if (near && !wheelUpRef.current) followOutputRef.current = true;
      // 真正滚回底部才解除「用户接管」，点击/微滚动不会误恢复。
      if (distance < 40) {
        userPausedRef.current = false;
        wheelUpRef.current = false;
      }
      const away = distance > 120;
      if (away !== lastAway) {
        lastAway = away;
        awayFromBottomRef.current = away;
        setAwayFromBottom(away);
      }

      const threshold = el.getBoundingClientRect().top + 96;
      let current = activeTurnRef.current;
      let found = false;
      const nodes = el.querySelectorAll<HTMLElement>('[data-turn-role="user"]');
      for (const node of nodes) {
        if (node.getBoundingClientRect().top > threshold) continue;
        const parsed = Number(node.id.slice("turn-".length));
        if (Number.isFinite(parsed)) {
          current = parsed;
          found = true;
        }
      }
      if (found && current !== lastActive) {
        lastActive = current;
        activeTurnRef.current = current;
        setActiveTurn(current);
      }
    };

    // 拖拽滚动期间暂停装饰性动画（打字机光标、脉冲点、转圈）：
    // 动画和滚动抢同一个合成线程，暂停后拖拽明显更跟手。
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const markScrolling = () => {
      el.dataset.scrolling = "true";
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimer = null;
        delete el.dataset.scrolling;
      }, 180);
    };

    const onScroll = () => {
      markScrolling();
      if (raf) return;
      raf = requestAnimationFrame(measure);
    };

    measure();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
      if (idleTimer) clearTimeout(idleTimer);
      delete el.dataset.scrolling;
    };
  }, [navAllItems.length, showTranscript]);

  // ------------------------------------------------------------------ 实时用量
  /** 流式期间的文字长度（用于估算 token / 费用），同时广播给状态栏。 */
  const liveTokens = useMemo(() => {
    const partial = chat.streamState.streamingMessage as
      | { content?: unknown; usage?: { output?: number } }
      | null;
    if (!partial) return 0;
    const usage = partial.usage;
    if (usage && typeof usage.output === "number" && usage.output > 0) return usage.output;
    // content 可能是 string（CustomMessage / 流式分片），必须走 messageText 归一化。
    return estimateTokens(messageText(partial));
  }, [chat.streamState.streamingMessage]);

  /**
   * 实时生成速度（tokens/s）：对 liveTokens 做 0.5s 采样 + 指数滑动平均，
   * 避免每来一个 token 就抖动。思考过程标题栏用它显示速度。
   */
  const [tokensPerSecond, setTokensPerSecond] = useState(0);
  const tokenRateRef = useRef<{ tokens: number; at: number; rate: number }>({ tokens: 0, at: 0, rate: 0 });

  useEffect(() => {
    if (!chat.agentRunning) {
      tokenRateRef.current = { tokens: 0, at: 0, rate: 0 };
      setTokensPerSecond(0);
      return;
    }
    const now = performance.now();
    const prev = tokenRateRef.current;
    // 新一轮消息（计数回退）或首次采样：只重置基准
    if (!prev.at || liveTokens < prev.tokens) {
      tokenRateRef.current = { tokens: liveTokens, at: now, rate: prev.rate };
      return;
    }
    const seconds = (now - prev.at) / 1000;
    if (seconds < 0.5) return;
    const instant = (liveTokens - prev.tokens) / seconds;
    const smoothed = prev.rate > 0 ? prev.rate * 0.6 + instant * 0.4 : instant;
    tokenRateRef.current = { tokens: liveTokens, at: now, rate: smoothed };
    setTokensPerSecond(Math.max(0, Math.round(smoothed)));
  }, [liveTokens, chat.agentRunning]);

  /**
   * 实时输入速度（tokens/s）：用户打字时对 draft 做同样的 0.5s 采样 + 指数平滑。
   * 与输出速率并列显示，形成双向动态。
   */
  const [inputTokensPerSecond, setInputTokensPerSecond] = useState(0);
  const inputRateRef = useRef<{ tokens: number; at: number; rate: number }>({ tokens: 0, at: 0, rate: 0 });
  useEffect(() => {
    const tokens = estimateTokens(draft);
    const now = performance.now();
    const prev = inputRateRef.current;
    if (tokens === 0) {
      inputRateRef.current = { tokens: 0, at: 0, rate: 0 };
      setInputTokensPerSecond(0);
      return;
    }
    if (!prev.at || tokens < prev.tokens) {
      inputRateRef.current = { tokens, at: now, rate: prev.rate };
      return;
    }
    const seconds = (now - prev.at) / 1000;
    if (seconds < 0.5) return;
    const instant = (tokens - prev.tokens) / seconds;
    const smoothed = prev.rate > 0 ? prev.rate * 0.6 + instant * 0.4 : instant;
    inputRateRef.current = { tokens, at: now, rate: smoothed };
    setInputTokensPerSecond(Math.max(0, Math.round(smoothed)));
  }, [draft]);

  /** 本轮累计输出：当前 user 消息之后已完成 assistant 消息的 output 之和（不含当前流式）。 */
  const turnOutputTokens = useMemo(() => {
    let sum = 0;
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      const message = chat.messages[i] as { role?: string; usage?: { output?: number } };
      if (message.role === "user") break;
      if (message.role === "assistant" && message.usage) sum += message.usage.output ?? 0;
    }
    return sum;
  }, [chat.messages]);

  /**
   * 正在跑的工具（并行时会有多个）。
   *
   * 以**消息**为准（有 toolCall、没 toolResult），再把 `agentPhase` 里刚 start、
   * 结果还没落盘的那些并进来：事件流断过也不会漏（以前只信事件流，一断就啥也不显示）。
   */
  const runningTools = useStickyRunningTools(
    useMemo(
      () =>
        collectRunningTools({
          messages: chat.messages,
          agentRunning: chat.agentRunning,
          phaseTools: chat.agentPhase?.kind === "running_tools" ? chat.agentPhase.tools : null,
        }),
      [chat.messages, chat.agentRunning, chat.agentPhase],
    ),
  );

  useEffect(() => {
    if (chat.agentRunning) {
      setLiveUsage({ tokens: liveTokens, cost: liveTokens * LIVE_COST_PER_TOKEN });
    } else {
      setLiveUsage(null);
    }
  }, [chat.agentRunning, liveTokens]);

  // 结束（或切换会话）时清掉残留的实时数字
  useEffect(() => () => setLiveUsage(null), []);

  // Ctrl/Cmd + End（或 Cmd/Ctrl + ↓）：一键回到最新对话，输入框聚焦时同样生效
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      const isEnd = event.key === "End";
      const isDown = event.key === "ArrowDown";
      if (!isEnd && !isDown) return;
      event.preventDefault();
      resumeFollow();
      scrollToBottom("smooth");
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [active, scrollToBottom, resumeFollow]);

  const trust = chat.trustPrompt;
  const trustCard = trust ? (
    <div className="mb-3 rounded-xl border border-[#D9E5FB] bg-[#F5F9FF] px-4 py-3">
      <p className="text-[12px] text-ink-muted">
        运行前需要确认信任该项目：
        <span className="ml-1 font-mono text-[11px] text-ink-soft">{trust.cwd}</span>
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {trust.options.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => chat.resolveTrustPrompt(option.id)}
            className="rounded-md border border-[#D9E5FB] bg-white px-2.5 py-1 text-[12px] text-ink-soft transition-colors hover:border-accent/40 hover:text-accent-strong"
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  ) : null;

  /**
   * `/imagine <prompt>` becomes an instruction that names the generate_image
   * tool. If no image model is configured the Agent cannot call the tool, so
   * the composer explains that instead of sending a doomed prompt.
   */
  const prepareOutgoing = async (text: string): Promise<{ cancel: boolean; text: string }> => {
    const message = buildImagineMessage(text);
    if (message === null) return { cancel: false, text };
    if (message === "") {
      setCompactToast({ ok: false, text: "请在 /imagine 后输入图片描述" });
      return { cancel: true, text };
    }
    try {
      const res = await fetch("/api/desktop-settings");
      const data = (await res.json()) as { imageModel?: unknown };
      if (res.ok && !data.imageModel) {
        setCompactToast({ ok: false, text: "请先在 设置 → 辅助模型 中选择生图模型" });
        return { cancel: true, text };
      }
    } catch {
      // Host unavailable: let the send fail through the normal error path.
    }
    return { cancel: false, text: message };
  };

  // 上游配额只拉一次：输入框下方的用量条与底部状态栏共享同一份快照，
  // 避免同一个上游配额接口被请求两遍（有速率限制风险）。
  const upstreamUsage = useUpstreamUsage(currentModel?.provider ?? null);

  const composer = (
    <div className="flex flex-col gap-2">      {chat.canExecutePlan && chat.agentMode === "plan" && (
        <div
          role="group"
          aria-label="计划已生成"
          className="flex items-center gap-2 self-start rounded-xl border border-[#D9E5FB] bg-[#F5F9FF] px-2.5 py-1.5 text-[12px] text-ink-soft shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
        >
          <ListTodo size={13} strokeWidth={1.9} className="shrink-0 text-accent" aria-hidden="true" />
          <span className="min-w-0">计划已生成，批准后开始执行。</span>
          <button
            type="button"
            onClick={() => {
              void chat.handleExecutePlan();
            }}
            disabled={chat.agentRunning}
            className="ml-1 shrink-0 rounded-md bg-accent px-2 py-1 text-[11.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            批准并执行
          </button>
          <button
            type="button"
            onClick={() => chat.dismissPlan()}
            className="shrink-0 rounded-md px-1.5 py-1 text-[11.5px] text-ink-muted transition-colors hover:bg-[#ECECEF] hover:text-ink"
          >
            拒绝
          </button>
        </div>
      )}
      {compactToast && (
        <div
          role="status"
          className={`flex items-center gap-1.5 self-start rounded-lg border bg-white px-2.5 py-1.5 text-[12px] shadow-[0_1px_3px_rgba(15,23,42,0.06)] ${
            compactToast.ok
              ? "border-[#D9E5FB] text-ink-soft"
              : "border-[#F5D3D3] text-danger"
          }`}
        >
          {compactToast.ok ? (
            <CheckCircle2 size={13} strokeWidth={2} className="shrink-0 text-accent" aria-hidden="true" />
          ) : (
            <AlertCircle size={13} strokeWidth={2} className="shrink-0" aria-hidden="true" />
          )}
          {compactToast.text}
        </div>
      )}
      {/* 后台引擎没起来时给一句提示，但**不做成白色卡片**：
          这里只是一行红字，避免在输入框上方多出一块色块挡住滚动区。 */}
      {hostHealth.state !== "ready" && (
        <div
          role="status"
          className="flex items-center gap-1.5 self-start px-1 pb-1 text-[12px] text-danger"
        >
          <AlertCircle size={13} strokeWidth={2} className="shrink-0" aria-hidden="true" />
          <span>
            {hostHealth.message}
            <span className="ml-1 text-ink-faint">
              （发送已停用；引擎恢复后自动可用）
            </span>
          </span>
        </div>
      )}
      {/* 上下文提醒：自动压缩已下线，靠近窗口上限只提醒 + 一键手动压缩。 */}
      {ctxReminderVisible && ctxReminder && (
        <div
          role="status"
          className="flex items-center gap-1.5 self-start rounded-lg border border-[#F2E2C4] bg-[#FFFBF2] px-2.5 py-1.5 text-[12px] text-ink-soft shadow-[0_1px_3px_rgba(15,23,42,0.06)]"
        >
          <AlertCircle size={13} strokeWidth={2} className="shrink-0 text-[#D97706]" aria-hidden="true" />
          <span className="min-w-0 truncate">
            {ctxReminder.overshoot
              ? `上下文已写满窗口（${formatContextTokens(
                  ctxReminder.tokens ?? 0,
                )} / ${formatContextCeiling(ctxReminder.ceiling)} token），下一轮可能被拒收`
              : `上下文已用 ${Math.round(ctxReminder.ratioToCeiling * 100)}%（${formatContextTokens(
                  ctxReminder.tokens ?? 0,
                )} / ${formatContextCeiling(ctxReminder.ceiling)} token）`}
            ，建议手动压缩
          </span>
          <button
            type="button"
            onClick={() => setCompactConfirmOpen(true)}
            disabled={!canCompact}
            className="ml-1 shrink-0 rounded-md bg-accent px-2 py-1 text-[11.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            压缩
          </button>
          <button
            type="button"
            onClick={() => setCtxReminderMutedAt(ctxReminder.tokens ?? 0)}
            aria-label="稍后提醒"
            className="shrink-0 rounded-md px-1.5 py-1 text-[11.5px] text-ink-muted transition-colors hover:bg-[#F3EDE1] hover:text-ink"
          >
            稍后
          </button>
        </div>
      )}
      {/* 一行横向铺开：token 统计在前，running 徽章（`order-last`）在后。
          布局稳定化：token 块恒挂载（空转时 `invisible` 只保留占位），
          否则工具结束后的 sticky 窗口里它一整块卸载，徽章会瞬移到行首。 */}
      {(runningTools.length > 0 || chat.agentRunning || inputTokensPerSecond > 0) && (
        <div className="mb-1 flex min-h-[18px] max-w-full min-w-0 shrink-0 flex-nowrap items-center gap-1.5 self-start">
          <div
            className={`flex shrink-0 items-center gap-1.5 rounded-md bg-[#F1F7FF] px-1.5 py-0.5 text-[10px] font-medium text-accent-strong ${
              chat.agentRunning || inputTokensPerSecond > 0 ? "" : "invisible"
            }`}
          >
              <span className="flex h-2.5 items-end gap-[2px]" aria-hidden="true">
                {[0, 1, 2].map((index) => (
                  <span
                    key={index}
                    className="beat-bar w-[2px] rounded-sm bg-accent"
                    style={{ height: "10px", animationDelay: `${index * 0.15}s` }}
                  />
                ))}
              </span>
              {inputTokensPerSecond > 0 && (
                <>
                  <span className="tabular-nums">↑ {inputTokensPerSecond}</span>
                  <span className="text-ink-faint">·</span>
                </>
              )}
              <span className="tabular-nums">↓ {tokensPerSecond} tokens/s</span>
              <span className="text-ink-faint">·</span>
              {/* 这里是**本轮全部模型调用的输出合计**（含思考与每个工具轮次），
                  不是"这一次请求的新增输入"。写清楚口径，免得看起来像凭空涨了几千。 */}
              <span
                className="tabular-nums"
                title="本轮所有模型调用的输出合计（含思考与工具轮次），不是单次请求的输入"
              >
                本轮产出 {(turnOutputTokens + liveTokens).toLocaleString()}
              </span>
              {/* 上下文：一个环就够了——走满=贴满窗口，变红脉冲=已越顶，数字只进 tooltip。 */}
              {chat.contextBudget && (
                <>
                  <span className="text-ink-faint">·</span>
                  <ContextRing budget={chat.contextBudget} compacting={chat.isCompacting} />
                </>
              )}
            </div>
          <RunningToolsBadge tools={runningTools} className="order-last min-w-0" />
        </div>
      )}
      <Composer
        value={draft}
        onValueChange={onDraftChange}
        busy={chat.agentRunning}
        disabled={hostHealth.state !== "ready"}
        onStop={() => {
          void chat.handleAbort();
        }}
        onSubmit={(text, images) => {
          // 用户亲手发消息 = 想看后续：无条件解除"用户接管"并贴底，
          // 不管之前翻到多远（这不是自动跟随，是显式意图）。
          resumeFollow();
          void prepareOutgoing(text).then((outgoing) => {
            if (!outgoing.cancel) void chat.handleSend(outgoing.text, images);
          });
        }}
        onSteer={(text, images) => {
          void prepareOutgoing(text).then((outgoing) => {
            if (outgoing.cancel) return;
            resumeFollow();
            void chat.handleSteer(outgoing.text, images).catch((error) => {
              setCompactToast({
                ok: false,
                text: `打断失败：${error instanceof Error ? error.message : String(error)}`,
              });
            });
          });
        }}
        onFollowUp={(text, images) => {
          void prepareOutgoing(text).then((outgoing) => {
            if (outgoing.cancel) return;
            resumeFollow();
            void chat.handleFollowUp(outgoing.text, images).catch((error) => {
              setCompactToast({
                ok: false,
                text: `加入队列失败：${error instanceof Error ? error.message : String(error)}`,
              });
            });
          });
        }}
        queuedFollowUps={chat.followUpQueue.items}
        onReorderFollowUps={chat.handleReorderFollowUps}
        onRemoveFollowUp={chat.handleRemoveFollowUp}
        queueBusy={chat.followUpQueueBusy}
        cwd={session?.cwd ?? newSessionCwd ?? null}
      />
      <UsageStrip
        sessionStats={chat.sessionStats}
        contextUsage={chat.contextUsage}
        contextBudget={chat.contextBudget}
        activity={chat.sessionActivity}
        upstreamUsage={upstreamUsage.currentUsage}
        allUsages={upstreamUsage.usages}
        loading={upstreamUsage.loading}
        onRefresh={upstreamUsage.refresh}
      />
    </div>
  );

  const statusBar = (
    <StatusBar
      isStreaming={chat.agentRunning}
      model={currentModel}
      modelNames={chat.modelNames}
      modelList={chat.modelList}
      onModelChange={chat.handleModelChange}
      thinkingLevel={chat.thinkingLevel as ThinkingLevel}
      availableThinkingLevels={availableThinkingLevels}
      onThinkingLevelChange={chat.handleThinkingLevelChange}
      agentMode={chat.agentMode}
      onAgentModeChange={chat.handleAgentModeChange}
      soundEnabled={soundEnabled}
      onSoundToggle={onSoundToggle}
      onCompactRequest={() => setCompactConfirmOpen(true)}
      onGitDiff={onOpenGitDiff}
      canCompact={canCompact}
      compacting={chat.isCompacting}
      projectPath={session?.cwd ?? newSessionCwd ?? null}
    />
  );

  /**
   * 标签切换只改变 `active`（仅用于快捷键与滚动副作用），消息内容不变。
   * 这里把整段 Transcript 记忆化：切标签时 React 直接复用同一个 element，
   * 不再对上千条消息做一次完整 reconcile —— 这是切换卡顿的主因。
   */
  /** 稳定引用：避免 `onApplyCode ? handler : undefined` 每帧都产生新值，破坏下游 memo。 */
  const applyCodeHandler = useMemo(
    () => (onApplyCode ? handleApplyCode : undefined),
    [onApplyCode, handleApplyCode],
  );

  const transcriptNode = useMemo(
    () => (
      <Transcript
        revealTurn={pendingJump?.turnIndex ?? null}
        precomputedTurns={visibleTurns}
        liveTurn={chat.agentRunning}
        tokensPerSecond={tokensPerSecond}
        liveToolOutputs={chat.liveToolOutput}
        streamingMessage={(streaming as AgentMessage | null) ?? null}
        messages={chat.messages}
        messageKeys={messageKeys}
        entryIds={chat.entryIds}
        onFork={chat.handleFork}
        forkingEntryId={chat.forkingEntryId}
        busy={actionsBlocked}
        cwd={session?.cwd ?? newSessionCwd}
        onOpenFile={onOpenFile}
        onInsertCode={onInsertCode}
        onApplyCode={applyCodeHandler}
        applyTargetName={applyTargetName}
        nestedExecutions={chat.nestedToolExecutions}
        onBranch={handleBranchAt}
        branchSwitch={branchSwitchFor}
        onSwitchBranch={handleSwitchBranch}
      />
    ),
    [
      messageKeys,
      chat.entryIds,
      chat.agentRunning,
      actionsBlocked,
      chat.handleFork,
      chat.forkingEntryId,
      chat.nestedToolExecutions,
      session?.cwd,
      newSessionCwd,
      onOpenFile,
      onInsertCode,
      applyCodeHandler,
      pendingJump?.turnIndex,
      visibleTurns,
      streaming,
      chat.messages,
      tokensPerSecond,
      chat.liveToolOutput,
      applyTargetName,
      handleBranchAt,
      branchSwitchFor,
      handleSwitchBranch,
    ],
  );

  return (
    <WatchdogSessionProvider sessionId={session?.id ?? null}>
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-[#FCFCFA]">
      {/* Extension UI: an extension awaiting input/select/confirm blocks the
          agent until this dialog answers, so it must render for every view. */}
      <ExtensionUiDialog
        request={chat.extensionUiRequest}
        onRespond={chat.handleExtensionUiRespond}
      />
      {chat.extensionUiNotify && (
        <div
          role="status"
          className="material-popover fixed left-1/2 top-12 z-[900] -translate-x-1/2 rounded-lg px-3 py-2 text-[12px] text-ink shadow-[var(--shadow-popover)]"
        >
          {chat.extensionUiNotify.message}
        </div>
      )}

      {showTranscript && session && (
        <BranchNavigator
          tree={navigatorTree}
          activeLeafId={chat.branches?.leafId ?? branchLeafId}
          onLeafChange={handleSwitchBranch}
          onBranch={() =>
            setBranchModal({ isOpen: true, mode: "branch", targetEntryId: branchLeafId ?? undefined })
          }
          onClone={() => setBranchModal({ isOpen: true, mode: "clone" })}
          hasSession
        />
      )}

      {loadFailed ? (
        /* 加载失败：只有一张居中的极简卡片，不再摆出「正常对话」的输入框 */
        <div className="flex min-h-0 flex-1 items-center justify-center px-8">
          <div className="w-full max-w-sm rounded-xl border border-[#E7E9EE] bg-white px-5 py-6 text-center shadow-[0_8px_30px_rgb(0,0,0,0.04)]">
            <AlertCircle
              size={20}
              strokeWidth={1.6}
              className="mx-auto text-[#C2554E]"
              aria-hidden="true"
            />
            <p className="mt-2 text-[13px] font-medium text-ink">无法加载这段会话</p>
            <p className="mt-1 break-all text-[11px] leading-relaxed text-ink-faint">
              {visibleErrorMessage(chat.error) ?? "本地引擎尚未就绪"}
            </p>
            <button
              type="button"
              onClick={() => void retrySessionLoad()}
              disabled={retrying || !session}
              className="mt-4 rounded-md border border-border bg-white px-3 py-1.5 text-[12px] font-medium text-ink-muted transition-colors duration-150 hover:bg-[#ECECEF] hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
            >
              {retrying ? "重试中…" : "重试"}
            </button>
            <p className="mt-2.5 text-[10.5px] leading-relaxed text-ink-faint">
              引擎重启或开发热更新时会出现，稍等几秒再重试即可。
            </p>
          </div>
        </div>
      ) : showTranscript ? (
        <>
          {/* 定位参照：右侧导航条 absolute 贴在本容器右边缘；overflow-hidden
              保证任何浮层都不会溢出到右边的终端/文件面板里去。 */}
          <div className="relative min-h-0 flex-1 overflow-hidden">
          <div
            ref={scrollRef}
            data-chat-scroll="true"
            data-streaming={chat.agentRunning ? "true" : undefined}
            className="scrollbar-ghost h-full min-h-0 overflow-y-auto [overflow-anchor:none]"
          >
            <div className="mx-auto w-full max-w-3xl px-8 py-10">
              {chat.loading && messages.length === 0 ? (
                <p className="py-10 text-center text-[13px] text-ink-faint">加载会话…</p>
              ) : (
                transcriptNode
              )}

              {chat.agentRunning && !streaming && (
                <p className="text-[12px] text-ink-faint">PiForge 正在思考…</p>
              )}
            </div>
            {/* 底部哨兵：IntersectionObserver 的唯一观测目标。
                1px 高、不参与交互，肉眼无感；放到内容层外面，避免影响内容 RO。 */}
            <div
              ref={bottomSentinelRef}
              aria-hidden="true"
              className="pointer-events-none h-px w-full"
            />
          </div>

          {/* 右侧对话导航（极简横条轴 + 悬浮白色列表面板） */}
          <TranscriptNav
            items={navAllItems}
            ticks={navTickPositions}
            activeIndex={activeTickIndex}
            activeItemIndex={activeUserPos}
            onJump={jumpToTurn}
          />

          </div>
          {/* 与上方消息内容用同一套 max-w-3xl + px-8，左右边界完全对齐 */}
          <div className="shrink-0 pb-4">
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-8">
              {trustCard}
              {/* 看门狗的可视化已全部收拢到右侧「系统监控」面板；
                  主聊天界面不订阅任何看门狗状态，也不会因此重渲染。 */}
              {/* Token 护栏：前缀失效（P2-2）/ 恢复成本（P2-3a），纯提示可关闭 */}
              <TokenGuardBanner
                hints={tokenGuardHints}
                onDismiss={(kind) => setDismissedGuards((prev) => (prev.includes(kind) ? prev : [...prev, kind]))}
                onNewSession={onNewSession}
              />
              {/* 输入面板 + 浮在它右上角外侧的「回到最新对话」按钮 */}
              <div className="relative" ref={composerContainerRef} onFocusCapture={stickToBottomIfNear}>
                {composer}
                <button
                  type="button"
                  onClick={() => {
                    resumeFollow();
                    scrollToBottom("auto");
                  }}
                  aria-label="回到最新对话"
                  title="回到最新对话（Ctrl/⌘ + End）"
                  className={`absolute -top-11 right-0 z-20 flex h-8 w-8 items-center justify-center rounded-full border border-[#E1E6F0] bg-white/80 text-ink-muted shadow-[0_2px_10px_rgba(17,17,17,0.10)] backdrop-blur-sm transition-all duration-200 hover:bg-white hover:text-ink ${
                    awayFromBottom ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
                  }`}
                >
                  <ArrowDown size={15} strokeWidth={2} aria-hidden="true" />
                </button>
              </div>
              <div className="shrink-0">{statusBar}</div>
            </div>
          </div>
        </>
      ) : (
        <div className="scrollbar-ghost chat-empty-canvas flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-8 py-6">
          <div className="my-auto flex w-full max-w-3xl flex-col items-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/logo.svg"
              alt="PiForge"
              width={64}
              height={64}
              draggable={false}
              className="h-16 w-16 select-none"
            />
            <p className="mt-2 text-[13px] text-ink-faint">今天想构建点什么？</p>
            <div className="mt-6 flex w-full flex-col gap-2">
              {trustCard}
              <div className="relative">
                {composer}
                <button
                  type="button"
                  onClick={() => {
                    resumeFollow();
                    scrollToBottom("auto");
                  }}
                  aria-label="回到最新对话"
                  title="回到最新对话（Ctrl/⌘ + End）"
                  className={`absolute -top-11 right-0 z-20 flex h-8 w-8 items-center justify-center rounded-full border border-[#E1E6F0] bg-white/80 text-ink-muted shadow-[0_2px_10px_rgba(17,17,17,0.10)] backdrop-blur-sm transition-all duration-200 hover:bg-white hover:text-ink ${
                    awayFromBottom ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
                  }`}
                >
                  <ArrowDown size={15} strokeWidth={2} aria-hidden="true" />
                </button>
              </div>
              <div className="shrink-0">{statusBar}</div>
            </div>
          </div>
        </div>
      )}

      <BranchCloneModal
        isOpen={branchModal.isOpen}
        onClose={() => setBranchModal((prev) => ({ ...prev, isOpen: false }))}
        mode={branchModal.mode}
        sessionId={session?.id ?? null}
        targetEntryId={branchModal.targetEntryId}
        cwd={session?.cwd ?? newSessionCwd ?? undefined}
        onSuccess={(newSessionId) => onSessionForked?.(newSessionId)}
      />

      {compactConfirmOpen && (
        <ModalSurface
          panelClassName="t-modal is-open ui-dialog-surface flex w-full max-w-sm flex-col overflow-hidden rounded-[14px]"
          ariaLabelledBy="compact-confirm-title"
        >
          <div className="flex flex-col gap-2 px-4 pb-4 pt-3.5">
            <h3 id="compact-confirm-title" className="text-[14px] font-semibold text-ink">
              压缩上下文？
            </h3>
            <p className="text-[12px] leading-relaxed text-ink-muted">
              将调用 Pi 的压缩能力，把较早的对话总结成一段摘要（保留改动过的文件、核心需求、当前进度与下一步），最近的内容完整保留。
            </p>
            <p className="text-[11px] text-ink-faint">
              压缩后原始历史会被摘要替换，无法撤销。
            </p>
          </div>
          <div className="mt-1 flex items-center justify-end gap-2 border-t border-divider px-4 py-3">
            <button
              type="button"
              onClick={() => setCompactConfirmOpen(false)}
              className="rounded-control border border-border px-3 py-1.5 text-[12px] text-text-muted transition-colors hover:bg-bg-hover hover:text-text"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void runCompact()}
              className="rounded-control bg-accent px-4 py-1.5 text-[12px] font-medium text-accent-contrast transition-opacity hover:opacity-90"
            >
              开始压缩
            </button>
          </div>
        </ModalSurface>
      )}
    </main>
    </WatchdogSessionProvider>
  );
}

export default ChatSurface;
