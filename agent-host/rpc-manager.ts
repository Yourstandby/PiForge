import { existsSync } from "fs";
import { unlink } from "fs/promises";
import { randomUUID } from "node:crypto";
import {
  createBashTool,
  createHostAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  SessionManager,
  type SessionEntry,
  type ToolDefinition,
} from "./sdk-adapter.ts";
import type { AgentSessionLike, ToolInfo } from "../lib/pi-types.ts";
import {
  DEFAULT_AGENT_MODE,
  DEFAULT_TOOL_PRESET,
  effectiveToolsForMode,
  isAgentMode,
  isToolPreset,
  type AgentMode,
  type ToolPreset,
  toolNamesForPreset,
} from "../lib/approval-policy.ts";
import { ExtensionUiBridge } from "./extension-ui-bridge.ts";
import { desktopApprovalInlineExtension, type AgentModeRef } from "./desktop-approval-extension.ts";
import { desktopLtmInlineExtension } from "./desktop-ltm-extension.ts";
import { readDesktopSettings, type CodemodeMode } from "../lib/desktop-settings.ts";
import { desktopRuntimeTools } from "./desktop-runtime-tools.ts";
import { desktopDedupeInlineExtension } from "./desktop-dedupe-extension.ts";
import { desktopToolGuardInlineExtension } from "./desktop-tool-guard-extension.ts";
import { desktopToolSchedulerInlineExtension } from "./desktop-tool-scheduler-extension.ts";
import { desktopFileOriginInlineExtension } from "./desktop-file-origin-extension.ts";
import { desktopCollabGuidanceInlineExtension } from "./desktop-collab-guidance-extension.ts";
import { desktopToolSearchAlignmentInlineExtension } from "./desktop-tool-search-alignment.ts";
import {
  applyCacheWarmingPolicy,
  describeCacheWarming,
  hasReplayablePrefix,
  warmPromptPrefix,
  type PrewarmResult,
} from "./cache-warming.ts";
import { canonicalToolOrder } from "./prompt-prefix.ts";
import { desktopProcessInlineExtension } from "./desktop-process-extension.ts";
import { desktopPowerShellInlineExtension } from "./desktop-powershell-extension.ts";
import { desktopDomainInlineExtension } from "./desktop-domain-extension.ts";
import {
  DOMAIN_LEGACY_TOOLS,
  resolveOnDemandDomains,
  setRuntimeOnDemandDomains,
} from "../lib/domain-tools.ts";
import { desktopOutputStyleInlineExtension } from "./desktop-output-style-extension.ts";
import { desktopBrowserInlineExtension } from "./desktop-browser-extension.ts";
import { desktopTerminalInlineExtension } from "./desktop-terminal-extension.ts";
import { desktopImageInlineExtension } from "./desktop-image-extension.ts";
import { desktopDecisionInlineExtension } from "./desktop-decision-extension.ts";
import { desktopToolOutputInlineExtension } from "./desktop-tool-output-extension.ts";
import { desktopSubagentInlineExtension } from "./desktop-subagent-extension.ts";
import { desktopHerdrInlineExtension } from "./desktop-herdr-extension.ts";
import { desktopPluginInlineExtension } from "./desktop-plugin-extension.ts";
import { desktopOrchestratorInlineExtension } from "./desktop-orchestrator-extension.ts";
import { desktopCompactionInlineExtension } from "./desktop-compaction-extension.ts";
import { compactionSummaryInstructions } from "./compaction-plan.ts";
import { describeContextBudget } from "./context-budget.ts";
import { auxToolAvailability } from "./aux-models.ts";
import { loadDesktopMcpConfig } from "../lib/mcp-config.ts";
import { findLastAgentMode } from "./agent-mode-persistence.ts";
import { applyPendingSessionLeaf } from "./session-branch-state.ts";
import {
  branchEntriesToMessagesText,
  lastAssistantFromBranch,
  lastUserFromBranch,
  safeLtmAgentEndObserve,
  safeLtmPreCompactObserve,
} from "./ltm/observe-hooks.ts";
import { FollowUpQueue, type FollowUpQueueSnapshot, type QueuedFollowUp } from "./follow-up-queue.ts";
import { attachSessionStream } from "./session-events.ts";
import {
  observeAgentEvent,
  registerWatchSession,
  forgetWatchSession,
} from "./watchdog.ts";
import type { InterventionDelivery } from "./intervention.ts";
import { resolveDelivery } from "./intervention.ts";
import {
  countUserMessages,
  firstUserTextFromBranch,
  generateSessionTitle,
  shouldAutoNameSession,
} from "./session-title.ts";

// ============================================================================
// Constants
// ============================================================================

// Thinking format identifier used by pi's deepseek compat layer (reasoningEffortMap
// maps xhigh→max for this format). Centralized as a constant so a pi-side rename
// only requires editing one location instead of hunting string literals.
// Tracked for upstream removal — see AgentSessionWrapper.applyDeepSeekXhighWorkaround.
const DEEPSEEK_THINKING_FORMAT = "deepseek";

// ============================================================================
// Types
// ============================================================================

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

type EventListener = (event: AgentEvent) => void;

// ============================================================================
// AgentSessionWrapper
// Wraps AgentSession with the same interface the rest of the app expects
// ============================================================================

export class AgentSessionWrapper {
  private listeners: EventListener[] = [];
  private unsubscribe: (() => void) | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private onDestroyCallbacks: Array<() => void> = [];
  private _alive = true;
  private _agentMode: AgentMode = DEFAULT_AGENT_MODE;
  private _toolPreset: ToolPreset = DEFAULT_TOOL_PRESET;
  private _toolPresetBeforePlan: ToolPreset | null = null;
  private _modeRef: AgentModeRef = { current: DEFAULT_AGENT_MODE };
  private _uiBridge: ExtensionUiBridge | null = null;
  /**
   * Extension binding runs after the session is handed back to the caller.
   * `bindExtensions` can block on an extension dialog (`session_start`)
   * launched via ctx.ui.input/select/confirm, and awaiting it inside
   * startRpcSession would deadlock the HTTP request that tells the renderer
   * the session id it needs to render that dialog. Prompts wait on this
   * promise instead.
   */
  private _binding: Promise<void> = Promise.resolve();
  private followUpQueue = new FollowUpQueue();
  private titleGenerationStarted = false;
  private pendingAgentEnd: AgentEvent | null = null;
  private queuedDispatchRetries = 0;
  /**
   * `agent_end` → `agent_settled` 之间不允许无限期挂起。
   * 正常情况下两个事件前后脚到达；只要 settled 丢失（扩展抛错、压缩卡住、
   * wrapper 中途 abort），`agent_end` 就会被永久扣在 pendingAgentEnd 里：
   * 前端一直忙、工具反馈不刷新、follow-up 队列也永远不 drain。
   * 这里用「事件静默」做兜底：超过阈值仍无任何事件就当作已经 settled。
   */
  private settleWatchdog: ReturnType<typeof setInterval> | null = null;
  private lastAgentEventAt = 0;
  /** 最后一次首轮预热的结果（get_state 里上报，便于排查"为什么没预热"）。 */
  private prewarm: PrewarmResult | null = null;
  /** 静默多久判定 settled 丢失。测试里会调小。 */
  static settleSilenceMs = 20_000;
  private suppressQueuedDispatchOnSettled = false;
  private resourcesChanged = false;
  private reloadingResources = false;
  private pendingCodemode: boolean | undefined;
  /**
   * codemode 呈现模式的可变载体（直接交给 SDK 的 createCodemodeExtension）。
   * SDK 的 `getMode` 是**惰性**读取的（每次构建请求时才调），所以改这里的值
   * 就对下一条消息生效，不用重建会话、也不用写全局 settings.json。
   */
  private codemodeOptions: { mode: CodemodeMode } | null = null;

  readonly inner: AgentSessionLike;

  constructor(inner: AgentSessionLike, options?: { modeRef?: AgentModeRef }) {
    this.inner = inner;
    if (options?.modeRef) {
      this._modeRef = options.modeRef;
      this._agentMode = options.modeRef.current;
    }
  }

  get agentMode(): AgentMode {
    return this._agentMode;
  }

  get toolPreset(): ToolPreset {
    return this._toolPreset;
  }

  /** Emit a synthetic event to SSE subscribers (extension UI, errors). */
  emitEvent(event: AgentEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (err) {
        console.error("Error in event listener:", err);
      }
    }
  }

  attachUiBridge(bridge: ExtensionUiBridge): void {
    this._uiBridge = bridge;
  }

  /** Deferred extension binding; resolved before the first prompt is sent. */
  setBinding(promise: Promise<void>): void {
    this._binding = promise;
    // Binding failures are surfaced through the prompt path; without this no-op
    // handler a session that never receives a prompt would leave an unhandled
    // rejection behind.
    void promise.catch(() => {});
  }

  get modeRef(): AgentModeRef {
    return this._modeRef;
  }

  initPolicy(mode: AgentMode, preset: ToolPreset, codemodeEnabled = false): void {
    this._agentMode = mode;
    this._toolPreset = preset;
    this._modeRef.current = mode;
    this._modeRef.toolPreset = preset;
    this._modeRef.codemodeEnabled = codemodeEnabled;
    if (mode === "plan") {
      this._toolPresetBeforePlan = preset;
    }
  }

  applyAgentMode(mode: AgentMode): void {
    if (mode === "plan" && this._agentMode !== "plan") {
      this._toolPresetBeforePlan = this._toolPreset;
    }
    if (mode !== "plan" && this._agentMode === "plan" && this._toolPresetBeforePlan) {
      this._toolPreset = this._toolPresetBeforePlan;
      this._toolPresetBeforePlan = null;
    }
    this._agentMode = mode;
    this._modeRef.current = mode;
    this._modeRef.toolPreset = this._toolPreset;
    const tools = canonicalToolOrder(desktopRuntimeTools(mode, this._toolPreset, this._modeRef.codemodeEnabled ?? false, this.inner.getAllTools(), this.inner.getActiveToolNames(), auxToolAvailability()));
    this.inner.setActiveToolsByName(tools);
  }
  setCodemodeEnabled(enabled: boolean): void {
    if (this.inner.isStreaming || this.pendingAgentEnd) {
      this.pendingCodemode = enabled;
      return;
    }
    this._modeRef.codemodeEnabled = enabled;
    this.applyAgentMode(this._agentMode);
  }
  /**
   * 切换 codemode 呈现模式（on = 工具照常声明；only = 全部经脚本调用）。
   * 与 `setCodemodeEnabled` 不同，这里不需要重算 active tools：声明集不变，
   * 只是下一条请求构建 loadout 时换一种呈现方式。
   */
  setCodemodeMode(mode: CodemodeMode): void {
    if (!this.codemodeOptions || this.codemodeOptions.mode === mode) return;
    this.codemodeOptions.mode = mode;
  }
  get codemodeMode(): CodemodeMode | null {
    return this.codemodeOptions?.mode ?? null;
  }
  /** 由 startRpcSession 把交给 SDK 的同一个对象挂上来（同一个引用，改即生效）。 */
  attachCodemodeOptions(options: { mode: CodemodeMode }): void {
    this.codemodeOptions = options;
  }

  requestResourceReload(): void {
    this.resourcesChanged = true;
  }

  private async reloadResources(): Promise<void> {
    if (this.reloadingResources) throw new Error("Session is reloading");
    if (!this.resourcesChanged || !this.inner.reload) return;
    this.reloadingResources = true;
    this.resourcesChanged = false;
    try {
      await this.inner.reload();
      this.applyAgentMode(this._agentMode);
    } catch (error) {
      this.resourcesChanged = true;
      throw error;
    } finally {
      this.reloadingResources = false;
    }
  }
  setAgentMode(mode: AgentMode): void {
    if (!isAgentMode(mode)) throw new Error(`Invalid agent mode: ${String(mode)}`);
    this.applyAgentMode(mode);
    if (this.inner.sessionManager && typeof this.inner.sessionManager.appendCustomEntry === "function") {
      this.inner.sessionManager.appendCustomEntry("desktop_agent_mode", { mode });
    }
  }

  /** Infer preset from tool name list when client calls set_tools. */
  private inferPresetFromTools(names: string[]): ToolPreset {
    const key = [...names].sort().join(",");
    if (key === "") return "none";
    if (key === [...toolNamesForPreset("default")].sort().join(",")) return "default";
    if (key === [...toolNamesForPreset("full")].sort().join(",")) return "full";
    return "default";
  }

  get sessionId(): string {
    return this.inner.sessionId;
  }

  get sessionFile(): string {
    return this.inner.sessionFile ?? "";
  }

  isAlive(): boolean {
    return this._alive;
  }

  start(): void {
    this.unsubscribe = this.inner.subscribe((event: AgentEvent) => {
      this.lastAgentEventAt = Date.now();
      this.resetIdleTimer();
      // 无进展看门狗：纯观测（同步、O(1)、无 IO），既不改事件也不发消息。
      // 它只在自己的内存状态里记时间戳，绝不触碰 prompt / 对话历史。
      observeAgentEvent(this.sessionId, event);
      // Best-effort LTM observe when an agent loop settles.
      if (event.type === "agent_end") {
        try {
          const source = Array.isArray(event.messages)
            ? (event.messages as unknown[])
            : (this.inner.sessionManager.getBranch() as unknown[]);
          void safeLtmAgentEndObserve({
            sessionId: this.sessionId,
            cwd: this.inner.sessionManager.getHeader()?.cwd ?? process.cwd(),
            userText: lastUserFromBranch(source),
            assistantText: lastAssistantFromBranch(source),
          });
        } catch (err) {
          console.error("ltm agent_end observe wire failed:", err);
        }
      }
      if (event.type === "agent_end") {
        this.pendingAgentEnd = event;
        this.startSettleWatchdog();
        return;
      }
      if (event.type === "agent_settled") {
        this.handleAgentSettled();
        return;
      }
      this.emitEvent(event);
    });
    this.resetIdleTimer();
  }

  private emitFollowUpQueue(snapshot = this.followUpQueue.snapshot()): FollowUpQueueSnapshot {
    this.emitEvent({ type: "follow_up_queue_update", ...snapshot });
    return snapshot;
  }

  private handleQueuedPromptFailure(item: QueuedFollowUp, completedEvent: AgentEvent | null, error: unknown): void {
    this.emitFollowUpQueue(this.followUpQueue.restoreFront(item));
    if (completedEvent) this.emitEvent(completedEvent);
    this.emitAgentError(error instanceof Error ? error.message : String(error));
    // 失败后没人会再唤醒队列（同一轮不会再有 agent_settled），
    // 不重试的话这条消息会永远停在队列里不发出去。
    this.scheduleQueuedDispatchRetry();
  }

  /** 队列派发失败后的有限重试（最多 2 次，3s 一次），避免压住消息又不成死循环。 */
  private scheduleQueuedDispatchRetry(): void {
    if (this.queuedDispatchRetries >= 2) return;
    this.queuedDispatchRetries += 1;
    const timer = setTimeout(() => {
      if (this.followUpQueue.snapshot().items.length === 0) return;
      if (this.pendingAgentEnd) return;
      let streaming = true;
      try {
        streaming = this.inner.isStreaming;
      } catch {
        streaming = false;
      }
      if (streaming) return;
      this.dispatchNextFollowUp(null);
    }, 3000);
    (timer as { unref?: () => void }).unref?.();
  }

  private dispatchNextFollowUp(completedEvent: AgentEvent | null): FollowUpQueueSnapshot {
    const claimed = this.followUpQueue.shift();
    // 上一轮的 agent_end 必须先进前端，再开下一轮。
    // 以前只在「队列为空」时才 emit，于是一旦队列非空，agent_end 就永久丢失：
    // UI 一直停在 agentRunning，排队的消息看起来「发不出去」。
    if (completedEvent) this.emitEvent(completedEvent);
    if (!claimed) return this.followUpQueue.snapshot();

    const snapshot = this.emitFollowUpQueue(claimed.snapshot);
    const { item } = claimed;
    try {
      const run = () => this.inner.prompt(item.message, item.images?.length ? { images: item.images } : undefined);
      const prompt = this.resourcesChanged ? this.reloadResources().then(run) : run();
      void prompt.then(
        () => {
          this.queuedDispatchRetries = 0;
        },
        (error) => this.handleQueuedPromptFailure(item, completedEvent, error),
      );
    } catch (error) {
      this.handleQueuedPromptFailure(item, completedEvent, error);
    }
    return snapshot;
  }

  /** 启动/复用一个 1s 轮询：静默太久就把 pendingAgentEnd 当作已 settled 收尾。 */
  private startSettleWatchdog(): void {
    this.lastAgentEventAt = Date.now();
    if (this.settleWatchdog) return;
    this.settleWatchdog = setInterval(() => {
      if (!this.pendingAgentEnd) {
        this.stopSettleWatchdog();
        return;
      }
      let streaming = true;
      try {
        streaming = this.inner.isStreaming;
      } catch {
        streaming = false;
      }
      // 还在跑就别抢跑：只是 settled 迟到，不是丢了。
      if (streaming) return;
      if (Date.now() - this.lastAgentEventAt < AgentSessionWrapper.settleSilenceMs) return;
      console.warn("[agent-host] agent_settled missing; settling after silence", this.sessionId);
      this.handleAgentSettled();
    }, 1000);
    // 别让兜底轮询把进程钉死（打包后 Node 环境下存在 unref）。
    (this.settleWatchdog as { unref?: () => void }).unref?.();
  }

  private stopSettleWatchdog(): void {
    if (!this.settleWatchdog) return;
    clearInterval(this.settleWatchdog);
    this.settleWatchdog = null;
  }

  private handleAgentSettled(): void {
    this.stopSettleWatchdog();
    if (this.pendingCodemode !== undefined) {
      this._modeRef.codemodeEnabled = this.pendingCodemode;
      this.pendingCodemode = undefined;
      this.applyAgentMode(this._agentMode);
    }
    const completedEvent = this.pendingAgentEnd;
    this.pendingAgentEnd = null;

    // First settled turn = the natural moment to name an untitled session.
    // Fire-and-forget: a title must never delay transcript delivery.
    void this.maybeGenerateSessionTitle();

    if (this.suppressQueuedDispatchOnSettled) {
      this.suppressQueuedDispatchOnSettled = false;
      if (completedEvent) this.emitEvent(completedEvent);
      return;
    }

    this.dispatchNextFollowUp(completedEvent);
  }

  /**
   * Auto-title: after the first turn of an unnamed session, ask the active
   * model for a ≤15 character title and persist it with pi's own
   * `setSessionName` (a normal `session_info` entry). Failures are silent —
   * a missing title must never surface as an agent error.
   */
  private async maybeGenerateSessionTitle(firstUserTextOverride?: string): Promise<void> {
    if (this.titleGenerationStarted) return;
    this.titleGenerationStarted = true;
    try {
      if (this.inner.sessionName) return;
      let firstUserText = firstUserTextOverride?.trim() ?? "";
      if (!firstUserText) {
        const branch = this.inner.sessionManager.getBranch() as unknown[];
        // Only the first user turn names a session; later turns must not
        // rewrite a title the user may have edited by hand.
        if (!shouldAutoNameSession(this.inner.sessionName, countUserMessages(branch))) return;
        firstUserText = firstUserTextFromBranch(branch);
      }
      if (!firstUserText) return;
      const title = await generateSessionTitle(
        {
          model: this.inner.model as never,
          modelRuntime: this.inner.modelRuntime as never,
        },
        firstUserText,
      );
      if (!title || this.inner.sessionName) return;
      this.inner.setSessionName?.(title);
    } catch (error) {
      console.error("Auto session title failed:", error);
    }
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.destroy().catch((err) => console.error("Error during idle destroy:", err));
    }, 10 * 60 * 1000);
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.push(listener);
    // A dialog may already be waiting: extensions can open one during
    // session_start, i.e. before the renderer has attached its SSE stream
    // (first message of a new session). Replay it instead of hanging.
    for (const request of this._uiBridge?.pendingRequests() ?? []) {
      try {
        listener(request);
      } catch (err) {
        console.error("Error replaying pending extension UI request:", err);
      }
    }
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i !== -1) this.listeners.splice(i, 1);
    };
  }

  /**
   * Emit an agent_error event to all listeners (SSE subscribers).
   * Used to surface pi-side prompt/steer/followUp failures to the client,
   * so the UI can reset agentRunning/agentPhase instead of hanging waiting
   * for an agent_end that will never come.
   *
   * Each listener is invoked inside try/catch so one throwing listener
   * does not prevent the others from receiving the event.
   *
   * NOTE: the message is currently passed through as-is. A sanitization
   * step (stripping paths / credentials) can be added later.
   */
  private emitAgentError(message: string): void {
    this.emitEvent({ type: "agent_error", errorMessage: message });
  }

  /**
   * Surface a background failure (e.g. a prompt dispatched after the HTTP
   * response was already sent) to every SSE subscriber.
   */
  reportError(message: string): void {
    this.emitAgentError(message);
  }

  onDestroy(cb: () => void): void {
    this.onDestroyCallbacks.push(cb);
  }

  /**
   * Signal that this wrapper is still in use (e.g., SSE heartbeat).
   * Resets the idle timer without emitting any events.
   * No-op if the wrapper is already destroyed.
   */
  keepAlive(): void {
    if (!this._alive) return;
    this.resetIdleTimer();
  }

  /**
   * 人工介入：把一段指令注入正在跑的这一轮（steer）、排到队首（queue）
   * 或直接开新一轮（prompt）。
   *
   * 三条都是**既有通路**：这里不新增任何模型调用入口，也不拼 system prompt。
   * 指令内容由调用方（`agent.intervene`）用纯函数生成，本方法只负责投递。
   */
  /**
   * 打断当前正在跑的工具（只给「强制跳过 + 工具已跑过阈值」用）。
   *
   * bash 会被 abort；不可中断的工具静默失败，不影响后续 steer 投递。
   */
  abortCurrentTool(): void {
    if (!this._alive) return;
    try {
      this.inner.abortBash?.();
    } catch (error) {
      this.emitAgentError(error instanceof Error ? error.message : String(error));
    }
  }

  async deliverIntervention(message: string): Promise<{ delivered: InterventionDelivery }> {
    if (!this._alive) throw new Error("Session is not running");
    let streaming = false;
    try {
      streaming = this.inner.isStreaming;
    } catch {
      streaming = false;
    }
    const queued = this.followUpQueue.snapshot().items.length;
    const delivery = resolveDelivery({ streaming, queued });

    if (delivery === "steer") {
      try {
        await this._binding.catch(() => undefined);
        // steer = 最高优先级：直接进入当前循环的下一步，立刻唤醒卡住的 Agent。
        await this.inner.steer(message);
        return { delivered: "steer" };
      } catch (error) {
        // steer 失败（循环刚好结束等）→ 退成排队，绝不丢掉用户手动发的指令。
        this.emitAgentError(error instanceof Error ? error.message : String(error));
      }
    }

    if (delivery === "queue" || delivery === "steer") {
      // steer 失败后也走这里：插到队首，保持“最高优先级”语义。
      const snapshot = this.followUpQueue.prepend({
        id: randomUUID(),
        message,
        createdAt: Date.now(),
      });
      this.emitFollowUpQueue(snapshot);
      if (!this.pendingAgentEnd) {
        let stillStreaming = false;
        try {
          stillStreaming = this.inner.isStreaming;
        } catch {
          stillStreaming = false;
        }
        if (!stillStreaming) this.dispatchNextFollowUp(null);
      }
      return { delivered: "queue" };
    }

    await this._binding.catch(() => undefined);
    if (this.resourcesChanged) await this.reloadResources();
    // 新一轮 prompt：与正常发送完全同一条路径。
    void this.inner
      .prompt(message)
      .catch((error) => this.emitAgentError(error instanceof Error ? error.message : String(error)));
    return { delivered: "prompt" };
  }

  /**
   * Build the current state snapshot. Shared by `send({ type: "get_state" })`
   * (which resets the idle timer, since the caller is actively driving the
   * session) and `peekState()` (which does not, since the caller is only
   * observing).
   */
  /**
   * Sum reasoning/thinking tokens across all session entries, mirroring the
   * SDK's `getSessionStats()` traversal (usage entries, compaction/branch
   * summaries, and assistant/toolResult message usage all carry `reasoning`).
   * `reasoning` is a subset of `output`, so it is reported separately and
   * never added to `total`.
   */
  private sumReasoningTokens(): number {
    const sessionManager = this.inner.sessionManager as
      | { getEntries?: () => SessionEntry[] }
      | undefined;
    const entries = sessionManager?.getEntries?.() ?? [];
    let reasoning = 0;
    const add = (usage: { reasoning?: number } | undefined) => {
      if (usage && typeof usage.reasoning === "number") reasoning += usage.reasoning;
    };
    for (const entry of entries) {
      if (entry.type === "usage") {
        add(entry.usage);
      } else if (entry.type === "branch_summary" || entry.type === "compaction") {
        add(entry.usage);
      }
      if (entry.type !== "message") continue;
      const message = entry.message;
      if (message.role === "assistant" || message.role === "toolResult") {
        add(message.usage);
      }
    }
    return reasoning;
  }

  /** 记录首轮预热结果（恢复会话的预热在 binding 里完成）。 */
  recordPrewarm(result: PrewarmResult): void {
    this.prewarm = result;
  }

  private buildStateSnapshot(): Record<string, unknown> {
    const model = this.inner.model;
    const contextUsage = this.inner.getContextUsage();
    // 预算挂在已有的 state 上：前端拿 get_state 就能知道离硬顶多远，
    // 不需要新路由、也不改命名管道协议。
    const contextBudget = describeContextBudget({
      tokens: contextUsage?.tokens ?? null,
      contextWindow: contextUsage?.contextWindow ?? 0,
    });
    const sessionStats = this.inner.getSessionStats?.();
    const reasoningTokens = this.sumReasoningTokens();
    const followUpQueue = this.followUpQueue.snapshot();
    return {
      sessionId: this.inner.sessionId,
      sessionFile: this.inner.sessionFile ?? "",
      isStreaming: this.inner.isStreaming,
      isCompacting: this.inner.isCompacting,
      autoCompactionEnabled: this.inner.autoCompactionEnabled,
      autoRetryEnabled: this.inner.autoRetryEnabled,
      model: model ? { id: model.id, provider: model.provider } : undefined,
      messageCount: 0,
      pendingMessageCount: followUpQueue.items.length,
      followUpQueue,
      contextUsage: contextUsage
        ? { percent: contextUsage.percent, contextWindow: contextUsage.contextWindow, tokens: contextUsage.tokens }
        : null,
      contextBudget,
      // 前缀棘轮审计：除按需域首次激活外，相邻两轮前缀必须字节一致。
      prefixAudit: this._modeRef.prefixAudit ?? {
        turns: 0,
        stableTurns: 0,
        expectedChanges: 0,
        unexpectedChanges: 0,
      },
      // 缓存保活的真实状态（模式 + warmer 状态 + 预热结果），设置页据此显示。
      cacheWarming: {
        ...describeCacheWarming(
          this.inner as unknown as Parameters<typeof describeCacheWarming>[0],
          (this.inner.settingsManager?.getSettings?.() as { cacheWarming?: unknown } | undefined)
            ?.cacheWarming
        ),
        ...(this.prewarm ? { prewarm: this.prewarm } : {}),
      },
      sessionStats: sessionStats
        ? {
            tokens: {
              ...sessionStats.tokens,
              ...(reasoningTokens > 0 ? { reasoning: reasoningTokens } : {}),
            },
            cost: sessionStats.cost,
            cacheHitRate:
              sessionStats.tokens.input + sessionStats.tokens.cacheRead + sessionStats.tokens.cacheWrite > 0
                ? (sessionStats.tokens.cacheRead /
                    (sessionStats.tokens.input + sessionStats.tokens.cacheRead + sessionStats.tokens.cacheWrite)) *
                  100
                : null,
          }
        : null,
      systemPrompt: this._toolPreset === "none" && this._agentMode !== "plan" ? "" : this.inner.agent.state?.systemPrompt ?? "",
      thinkingLevel: this.inner.agent.state?.thinkingLevel ?? "off",
      agentMode: this._agentMode,
      toolPreset: this._toolPreset,
      pendingUiRequestCount: this._uiBridge?.pendingCount ?? 0,
    };
  }

  /**
   * Read-only state snapshot. Returns the same payload as
   * `send({ type: "get_state" })` but does NOT reset the idle timer.
   *
   * Use this from observation endpoints (e.g.
   * `GET /api/sessions/[id]?includeState=1`) so that polling clients —
   * sidebar refreshes, stats panels — don't accidentally keep idle sessions
   * alive forever and prevent the 10-minute idle reclamation. Callers that
   * are intentionally driving the session should still use
   * `send({ type: "get_state" })`.
   */
  peekState(): Record<string, unknown> {
    return this.buildStateSnapshot();
  }

  async send(command: Record<string, unknown>): Promise<unknown> {
    this.resetIdleTimer();
    const type = command.type as string;

    switch (type) {
      case "prompt": {
        // Server-side backstop: the UI disables the send button while
        // streaming, but a racing / double-fired prompt (double-click, retry
        // after a dropped agent_end) must not start a second agent loop in
        // parallel with the in-flight one. Reject deterministically here
        // instead of relying on pi's internal isStreaming handling.
        if (this.inner.isStreaming || this.reloadingResources) throw new Error("Session is streaming or reloading");
        if (this.resourcesChanged) await this.reloadResources();
        try {
          await this._binding;
        } catch (error) {
          this.emitAgentError(error instanceof Error ? error.message : String(error));
          return null;
        }
        this.suppressQueuedDispatchOnSettled = false;
        // Name the session from its first message while the turn runs, so the
        // `session_info_changed` event lands on an open SSE stream.
        void this.maybeGenerateSessionTitle(command.message as string);
        // Fire and forget — events come via subscribe
        const promptImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        this.inner.prompt(command.message as string, promptImages?.length ? { images: promptImages } : undefined)
          .catch((err) => {
            console.error("pi prompt failed:", err);
            this.emitAgentError(err instanceof Error ? err.message : String(err));
          });
        return null;
      }

      case "abort":
        this.suppressQueuedDispatchOnSettled = true;
        try {
          await this.inner.abort();
          return null;
        } catch (error) {
          this.suppressQueuedDispatchOnSettled = false;
          throw error;
        }

      case "get_state": {
        return this.buildStateSnapshot();
      }

      case "set_model": {
        const { provider, modelId } = command as { provider: string; modelId: string };
        const model = this.inner.modelRuntime.getModel(provider, modelId);
        if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
        await this.inner.setModel(model);
        return { id: model.id, provider: model.provider };
      }

      case "fork": {
        // Refuse to fork while the session is actively streaming: the branch
        // copy below reads the .jsonl up to the fork point, which is unsafe
        // mid-write (a half-appended line), and the trailing this.destroy()
        // would abort the running loop mid-turn. The UI disables fork while
        // streaming; this is the deterministic server-side backstop.
        if (this.inner.isStreaming) throw new Error("Session is streaming");
        const entryId = command.entryId as string;
        const sessionManager = this.inner.sessionManager;
        const currentSessionFile = this.inner.sessionFile;

        if (!sessionManager.isPersisted()) return { cancelled: true };
        if (!currentSessionFile) throw new Error("Persisted session is missing a session file");

        // Guard: refuse to fork if the underlying session file has been deleted
        // (e.g., a concurrent DELETE racing with this fork — see Task D4).
        // isPersisted() reflects in-memory state and may still return true while
        // the file is already gone; without this check, SessionManager.open()
        // below would throw, or — worse — createBranchedSession would produce a
        // new .jsonl whose parentSession references a dead path. existsSync is a
        // synchronous stat; acceptable here because fork is already an async,
        // user-initiated, infrequent operation.
        if (!existsSync(currentSessionFile)) return { cancelled: true };

        const entry = sessionManager.getEntry(entryId);
        if (!entry) throw new Error("Invalid entry ID for forking");

        const sessionDir = sessionManager.getSessionDir();
        let newSessionFile: string;

        if (!entry.parentId) {
          // Fork before the first message: create an empty session linked to this one
          const newManager = SessionManager.create(sessionManager.getCwd(), sessionDir);
          newManager.newSession({ parentSession: currentSessionFile });
          newSessionFile = newManager.getSessionFile() as string;
        } else {
          // Fork after some history: copy path up to (but not including) the fork point
          const sourceManager = SessionManager.open(currentSessionFile, sessionDir);
          const forkedPath = sourceManager.createBranchedSession(entry.parentId);
          if (!forkedPath) throw new Error("Failed to create forked session");
          newSessionFile = forkedPath;
        }

        const newSessionId = SessionManager.open(newSessionFile, sessionDir).getSessionId();

        // Pre-register the new wrapper BEFORE destroying the old.
        // Contract: by the time send() returns, newSessionId is in the registry.
        // If startRpcSession throws, do NOT destroy — old wrapper stays usable under the old id.
        // The orphaned new .jsonl file is cleaned up in the catch below (its name is a unique
        // <timestamp>_<uuid>.jsonl, so it would never be overwritten by future forks).
        const newCwd = sessionManager.getHeader()?.cwd ?? process.cwd();
        try {
          await startRpcSession(newSessionId, newSessionFile, newCwd);
        } catch (err) {
          // startRpcSession failed: clean up the orphan .jsonl file (it uses a unique
          // <timestamp>_<uuid>.jsonl name, so it would never be overwritten by future forks).
          await unlink(newSessionFile).catch(() => { /* best-effort: file may not exist */ });
          throw err;
        }

        await this.destroy();
        return { cancelled: false, newSessionId };
      }

      case "navigate_tree": {
        const result = await this.inner.navigateTree(command.targetId as string, {});
        return { cancelled: result.cancelled };
      }

      case "set_thinking_level": {
        const level = command.level as string;
        this.inner.setThinkingLevel(level);
        // setThinkingLevel clamps xhigh→high for models where supportsXhigh()===false.
        // For deepseek compat models, force xhigh back so the compat layer works.
        // See applyDeepSeekXhighWorkaround for details and upstream tracking.
        this.applyDeepSeekXhighWorkaround(level);
        return null;
      }

      case "compact": {
        // Refuse to compact while streaming: the pre-check reads
        // sessionManager.getBranch() (possibly mid-write) and pi's compact()
        // aborts the running loop as a side effect. The UI hides the compact
        // button while streaming; this is the server-side backstop.
        if (this.inner.isStreaming) throw new Error("Session is streaming");
        // pi's compact() does not guard against empty messagesToSummarize — use findCutPoint
        // to pre-check and throw a clean error instead of generating a useless empty summary.
        const { findCutPoint, DEFAULT_COMPACTION_SETTINGS } = await import("./sdk-adapter.ts");
        const pathEntries = this.inner.sessionManager.getBranch() as Array<{ type: string }>;
        const settings = { ...DEFAULT_COMPACTION_SETTINGS, ...this.inner.settingsManager.getCompactionSettings() };
        let prevCompactionIndex = -1;
        for (let i = pathEntries.length - 1; i >= 0; i--) {
          if (pathEntries[i].type === "compaction") { prevCompactionIndex = i; break; }
        }
        const boundaryStart = prevCompactionIndex + 1;
        const cutPoint = findCutPoint(pathEntries as never, boundaryStart, pathEntries.length, settings.keepRecentTokens);
        const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
        if (historyEnd <= boundaryStart) {
          throw new Error("Conversation too short to compact");
        }
        // Best-effort LTM observe of branch text before compaction rewrites context.
        void safeLtmPreCompactObserve({
          sessionId: this.sessionId,
          cwd: this.inner.sessionManager.getHeader()?.cwd ?? process.cwd(),
          messagesText: branchEntriesToMessagesText(pathEntries),
        });
        const result = await this.inner.compact(
          (command.customInstructions as string | undefined) ?? compactionSummaryInstructions(),
        );
        return result;
      }

      case "set_auto_compaction": {
        this.inner.setAutoCompactionEnabled(command.enabled as boolean);
        return null;
      }

      case "reload_resources": {
        if (this.inner.isStreaming) throw new Error("Session is streaming");
        this.requestResourceReload();
        await this.reloadResources();
        return null;
      }

      case "steer": {
        const steerImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        try {
          await this.inner.steer(command.message as string, steerImages?.length ? steerImages : undefined);
        } catch (err) {
          console.error("pi steer failed:", err);
          this.emitAgentError(err instanceof Error ? err.message : String(err));
          throw err;
        }
        return null;
      }

      case "follow_up": {
        const followImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        const snapshot = this.followUpQueue.enqueue({
          id: randomUUID(),
          message: command.message as string,
          images: followImages?.length ? followImages : undefined,
          createdAt: Date.now(),
        });
        this.emitFollowUpQueue(snapshot);

        // The renderer can still think a run is active while its final SSE
        // events are in transit. If the wrapper is already fully idle, there
        // will be no future agent_settled event to drain this item, so dispatch
        // it immediately. pendingAgentEnd means agent_settled is still due and
        // remains the single ordering boundary for that run.
        if (!this.inner.isStreaming && !this.pendingAgentEnd) {
          return this.dispatchNextFollowUp(null);
        }
        return snapshot;
      }

      case "reorder_follow_ups": {
        const snapshot = this.followUpQueue.reorder(
          command.orderedIds as string[],
          command.expectedRevision as number,
        );
        return this.emitFollowUpQueue(snapshot);
      }

      case "remove_follow_up": {
        const snapshot = this.followUpQueue.remove(
          command.id as string,
          command.expectedRevision as number,
        );
        return this.emitFollowUpQueue(snapshot);
      }

      case "get_tools": {
        const all: ToolInfo[] = this.inner.getAllTools();
        const active = new Set<string>(this.inner.getActiveToolNames());
        return all.map((t) => ({
          name: t.name,
          description: t.description,
          active: active.has(t.name),
        }));
      }

      case "set_tools": {
        const toolNames = (command.toolNames as string[]) ?? [];
        this._toolPreset = this.inferPresetFromTools(toolNames);
        if (this._agentMode === "plan") this._toolPresetBeforePlan = this._toolPreset;
        this.applyAgentMode(this._agentMode);
        return null;
      }

      case "prewarm": {
        // 手动预热（设置页/诊断用）：用 maxTokens:1 重放当前前缀。
        const result = await warmPromptPrefix(this.inner);
        this.recordPrewarm(result);
        return result;
      }

      case "set_agent_mode": {
        const mode = command.mode;
        if (!isAgentMode(mode)) throw new Error(`Invalid agent mode: ${String(mode)}`);
        this.setAgentMode(mode);
        return { agentMode: this._agentMode, toolPreset: this._toolPreset };
      }

      case "extension_ui_response": {
        if (!this._uiBridge) throw new Error("No extension UI bridge");
        const id = command.id as string;
        if (typeof id !== "string" || !id) throw new Error("extension_ui_response requires id");
        const err = this._uiBridge.respond({
          id,
          confirmed: command.confirmed as boolean | undefined,
          value: command.value as string | undefined,
          cancelled: command.cancelled as boolean | undefined,
        });
        if (err) throw new Error(err);
        return null;
      }

      case "abort_compaction": {
        this.inner.abortCompaction();
        return null;
      }

      case "set_auto_retry": {
        this.inner.setAutoRetryEnabled(command.enabled as boolean);
        return null;
      }

      default:
        throw new Error(`Unsupported command: ${type}`);
    }
  }

  /**
   * Workaround for DeepSeek thinking format compat: pi's setThinkingLevel clamps
   * xhigh→high when supportsXhigh()===false, but for models with deepseek thinking
   * format, the compat layer (reasoningEffortMap maps xhigh→max) needs the raw
   * xhigh value. Force the state back.
   *
   * This hack is isolated here (not inlined in set_thinking_level case) so it's
   * easy to remove once pi's setThinkingLevel handles compat internally.
   * Tracked in upstream pi issue (TODO: link).
   *
   * Once pi's setThinkingLevel handles compat internally, remove this method
   * and the call site in the set_thinking_level case above.
   *
   * @returns true if the workaround was applied, false otherwise.
   */
  private applyDeepSeekXhighWorkaround(level: string): boolean {
    if (level !== "xhigh") return false;
    const model = this.inner.model as { compat?: { thinkingFormat?: string } } | null;
    if (model?.compat?.thinkingFormat !== DEEPSEEK_THINKING_FORMAT) return false;
    const state = this.inner.agent?.state as { thinkingLevel?: string } | undefined;
    if (!state) return false;
    state.thinkingLevel = "xhigh";
    return true;
  }

  async destroy(): Promise<void> {
    if (!this._alive) return;
    this._alive = false;
    this.stopSettleWatchdog();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    // Unsubscribe BEFORE aborting. abort() emits terminal events (agent_end,
    // agent_error, …) as it tears down the loop; with the SSE listener still
    // attached, those would be delivered to a stream that is about to close
    // (previously papered over by the per-listener try/catch, M2). Detaching
    // first shrinks that delivery window to ~zero.
    // Await unsubscribe in case pi's subscribe() returns an async cleanup fn
    // in the future. Current type is `() => void` (sync) — awaiting a void
    // expression is a no-op but future-proof.
    try {
      await this.unsubscribe?.();
    } catch (err) {
      console.error("Error during unsubscribe:", err);
    }
    // Terminate the inner pi agent loop. Without this, a forked/deleted
    // session keeps running and writing its .jsonl (snapshot after fork is
    // lost; DELETE fails on Windows with EPERM because the file is open), and
    // stale wrappers accumulate live AgentSessions holding runtime resources.
    // Best-effort: abort() is a no-op when the loop is already idle.
    try {
      await this.inner.abort();
    } catch (err) {
      console.error("Error aborting inner agent session:", err);
    }
    try {
      this._uiBridge?.destroy();
    } catch (err) {
      console.error("Error destroying UI bridge:", err);
    }
    this._uiBridge = null;
    try {
      await this.inner.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    } catch (err) {
      console.error("Error shutting down extensions:", err);
    }
    try {
      this.inner.dispose?.();
    } catch (err) {
      console.error("Error disposing inner agent session:", err);
    }
    for (const cb of this.onDestroyCallbacks) {
      try {
        await cb();
      } catch (err) {
        console.error("Error in onDestroy callback:", err);
      }
    }
    this.onDestroyCallbacks = [];
  }
}

// ============================================================================
// Session registry
// ============================================================================

const registry = new Map<string, AgentSessionWrapper>();
const startLocks = new Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>>();

export type StartRpcSessionOptions = {
  toolNames?: string[];
  agentMode?: AgentMode;
  toolPreset?: ToolPreset;
};

function normalizeStartOptions(
  toolNamesOrOpts?: string[] | StartRpcSessionOptions
): StartRpcSessionOptions {
  if (Array.isArray(toolNamesOrOpts)) return { toolNames: toolNamesOrOpts };
  return toolNamesOrOpts ?? {};
}

function getRegistry(): Map<string, AgentSessionWrapper> {
  return registry;
}

function getLocks(): Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> {
  return startLocks;
}

export function getRpcSession(sessionId: string): AgentSessionWrapper | undefined {
  return getRegistry().get(sessionId);
}

/** Internal registry access for host-side introspection and tests. */
export function getRpcSessionRegistry(): Map<string, AgentSessionWrapper> {
  return getRegistry();
}

/** Live sessions (used by health, model refresh and shutdown). */
export function listRpcSessions(): AgentSessionWrapper[] {
  return [...getRegistry().values()].filter((session) => session.isAlive());
}

/** Destroy every live session so JSONL writes are flushed before the host exits. */
export async function destroyAllRpcSessions(): Promise<number> {
  const sessions = listRpcSessions();
  await Promise.allSettled(sessions.map((session) => session.destroy()));
  getRegistry().clear();
  return sessions.length;
}

export function updateSessionCodemode(enabled: boolean, mode?: CodemodeMode): void {
  for (const session of getRegistry().values()) {
    session.setCodemodeEnabled(enabled);
    if (mode) session.setCodemodeMode(mode);
  }
}

export function requestSessionResourceReload(cwd?: string): void {
  for (const session of getRegistry().values()) {
    if (!cwd || session.inner.sessionManager.getHeader()?.cwd === cwd) session.requestResourceReload();
  }
}

/**
 * Get or create an AgentSession for the given session.
 * For new sessions (sessionFile === ""), pi generates its own id.
 * Pass toolNames to pre-configure active tools (empty array = all tools disabled).
 */
export async function startRpcSession(
  sessionId: string,
  sessionFile: string,
  cwd: string,
  toolNamesOrOpts?: string[] | StartRpcSessionOptions
): Promise<{ session: AgentSessionWrapper; realSessionId: string }> {
  const registry = getRegistry();
  const locks = getLocks();
  const opts = normalizeStartOptions(toolNamesOrOpts);

  const existing = registry.get(sessionId);
  if (existing?.isAlive()) return { session: existing, realSessionId: sessionId };

  const inflight = locks.get(sessionId);
  if (inflight) return inflight;

  const starting = (async () => {
    const {
      SessionManager,
      getAgentDir,
      DefaultResourceLoader,
    } = await import("./sdk-adapter.ts");
    const agentDir = getAgentDir();
    const desktop = readDesktopSettings(agentDir);
    /**
     * 按需域：环境变量 > 设置项 `onDemandDomains` > 默认（shell）。
     * 解析结果写进 domain-tools 的运行期状态，声明/合成/棘轮都用同一份。
     */
    const onDemand = resolveOnDemandDomains({
      env: process.env,
      settings: desktop.onDemandDomains ?? null,
    });
    setRuntimeOnDemandDomains(onDemand.domains);

    const sessionManager = sessionFile
      ? SessionManager.open(sessionFile, undefined)
      : SessionManager.create(cwd, undefined);
    // A branch selected while the session was cold must be honored before the
    // first prompt appends to the transcript.
    applyPendingSessionLeaf(sessionId, sessionManager);

    const storedMode = findLastAgentMode(sessionManager.getEntries() as never);
    const agentMode: AgentMode = isAgentMode(opts.agentMode)
      ? opts.agentMode
      : (storedMode ?? desktop.defaultAgentMode);
    let toolPreset: ToolPreset = isToolPreset(opts.toolPreset)
      ? opts.toolPreset
      : desktop.defaultToolPreset;

    // If caller passed explicit toolNames (legacy), infer preset when possible.
    if (opts.toolNames && !opts.toolPreset) {
      const key = [...opts.toolNames].sort().join(",");
      if (key === "") toolPreset = "none";
      else if (key === [...toolNamesForPreset("default")].sort().join(",")) toolPreset = "default";
      else if (key === [...toolNamesForPreset("full")].sort().join(",")) toolPreset = "full";
    }

    // memory 已改为按需域（tool_search 激活）；plan 模式的只读 recall 由 PLAN_TOOLS 显式带上。
    const effectiveTools = effectiveToolsForMode(agentMode, toolPreset);

    const modeRef: AgentModeRef = {
      current: agentMode,
      toolPreset,
      codemodeEnabled: desktop.codemodeEnabled ?? false,
      /** cwd 只用于用户消息的 <context> 块，不进 system prompt。 */
      getCwd: () => cwd,
      /** 提示词附加项：设置项默认开，用户关掉只是少几段静态文本。 */
      promptAddons: {
        outputStyle: desktop.outputStyleGuidelines !== false,
        responseLanguage: desktop.responseLanguageGuideline !== false,
        collab: desktop.collabGuidelines !== false,
      },
    };
    /**
     * 历史压缩扩展必须在 resourceLoader 之前注册，但它要读的分支 / 模型
     * 只有 session 建好之后才有 —— 用一个可变引用接上。
     */
    let sessionForCompaction: AgentSessionLike | null = null;
    /**
     * codemode 模式：设置里 `only` 时普通工具不再声明给模型，全部经脚本调用
     * （提示词少一整套 schema + 天然批量）。用可变对象传给 SDK，
     * 设置页切换后下一条消息就生效。
     */
    const codemodeOptions: { mode: CodemodeMode } = { mode: desktop.codemodeMode ?? "only" };
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      extensionFactories: [
        createCodemodeExtension(codemodeOptions),
        createToolSearchExtension(),
        createMcpExtension({ loadConfig: (ctx) => loadDesktopMcpConfig(agentDir, ctx.cwd, ctx.isProjectTrusted()) }),
        desktopApprovalInlineExtension(modeRef),
        // tool_search 结果必须只含可调用的 wire name（旧注册名会让模型调不通）。
        desktopToolSearchAlignmentInlineExtension(),
        // 每轮增量去重：重复 read / 重复命令只回一句或尾部差异（错误永远完整返回）。
        desktopDedupeInlineExtension(),
        // 工具护栏：shell 类工具补默认超时 + 封顶（防单条长驻调用把整批挂死），
        // 单批并行过多时追加一次提醒。只补参数 / 只在超时错误后追加一句改法，不改正常结果。
        desktopToolGuardInlineExtension(),
        // 会话隔离：跨会话共享配额（全局 + 单会话），超额调用在 tool_call 里排队而不是同时开跑。
        // 必须排在审批扩展之后——被审批拦下的调用不能先占槽位。
        desktopToolSchedulerInlineExtension({ getSessionKey: () => sessionId }),
        // 跨会话改动署名：别的会话改过的文件，read 时尾部多一行"谁改的"。
        // 必须排在去重之后（去重先判等，署名再追加文本，顺序反了会污染去重哈希）。
        desktopFileOriginInlineExtension(),
        // 上下文压缩**默认交给 pi 自己的策略**（`shouldCompact` +
        // `DEFAULT_COMPACTION_SETTINGS`，按模型窗口算，不掺任何绝对 token 硬顶）。
        // PiForge 自研的窗口 / 预算 / 硬顶触发只在显式打开时接管，用于 A/B：
        // 代码与单测都保留，但不进默认路径。
        ...(process.env.PIFORGE_DESKTOP_COMPACTION === "1"
          ? [
              desktopCompactionInlineExtension({
                getEntries: () => (sessionForCompaction?.sessionManager.getBranch() ?? []) as never,
                getTarget: () => ({
                  model: sessionForCompaction?.model,
                  modelRuntime: sessionForCompaction?.modelRuntime as never,
                }),
                log:
                  process.env.PIFORGE_DEBUG_COMPACT === "1"
                    ? (message, detail) => console.log(message, detail ?? "")
                    : undefined,
              }),
            ]
          : []),
        desktopLtmInlineExtension({ getCwd: () => cwd }),
        desktopProcessInlineExtension({ getCwd: () => cwd }),
        desktopPowerShellInlineExtension(() => cwd),
        desktopOutputStyleInlineExtension({
          enabled: () => modeRef.promptAddons?.outputStyle !== false,
        }),
        // 多会话协作协议：先看 git / 每步提交 / 见到署名先 diff / 独立活走 worktree。
        desktopCollabGuidanceInlineExtension({
          enabled: () => modeRef.promptAddons?.collab !== false,
        }),
        desktopBrowserInlineExtension(),
        desktopTerminalInlineExtension({ getCwd: () => cwd }),
        desktopImageInlineExtension(),
        desktopDecisionInlineExtension(),
        desktopToolOutputInlineExtension(),
        desktopSubagentInlineExtension(),
        desktopHerdrInlineExtension(),
        desktopPluginInlineExtension(),
        desktopOrchestratorInlineExtension(),
        /** 必须最后加载：它要读前面各扩展登记的动作。 */
        desktopDomainInlineExtension(),
      ],
    });
    await resourceLoader.reload();

    /**
     * Windows 中文乱码修复：pi 的 bash 工具在 Windows 上走 Git Bash，
     * `ping` 这类 System32 程序按 ANSI 代码页（GBK）输出，被当成 UTF-8 解码后
     * 变成 U+FFFD（不可逆）。这里注册一个同名 bash 覆盖，执行前先 `chcp 65001`，
     * 让子进程按 UTF-8 输出（实测 ping 输出不再含乱码）。
     */
    const WIN_UTF8_PREFIX = "chcp.com 65001 > /dev/null 2>&1 || true";
    const customTools: ToolDefinition[] =
      process.platform === "win32"
        ? [
            createBashTool(cwd, { commandPrefix: WIN_UTF8_PREFIX }) as unknown as ToolDefinition,
          ]
        : [];

    const { session: inner } = await createHostAgentSession({
      cwd,
      agentDir,
      sessionManager,
      resourceLoader,
      customTools,
      // Keep the registry open for MCP tools discovered after session_start.
      // Desktop policy selects declarations and checks every execution.
      noTools: "builtin",
    });

    sessionForCompaction = inner as unknown as AgentSessionLike;
    // 缓存保活：把「原始设置 → 有效模式」落到会话上（桌面默认 idle）。
    const cacheWarmingMode = applyCacheWarmingPolicy(
      inner as unknown as AgentSessionLike,
      (inner.settingsManager.getSettings() as { cacheWarming?: unknown } | undefined)?.cacheWarming
    );

    if (effectiveTools.length > 0) {
      inner.setActiveToolsByName(canonicalToolOrder([...effectiveTools, ...inner.getActiveToolNames()]));
    }

    // Pi 0.87+ systemPrompt is read-only. The desktop before_agent_start hook
    // supplies an empty prompt when the tool preset is none.

    // AgentSession is structurally compatible with AgentSessionLike; cast keeps
    // our thin facade free of full ExtensionUIContext coupling.
    const wrapper = new AgentSessionWrapper(inner as unknown as AgentSessionLike, { modeRef });
    wrapper.initPolicy(agentMode, toolPreset, desktop.codemodeEnabled ?? false);
    wrapper.attachCodemodeOptions(codemodeOptions);

    const bridge = new ExtensionUiBridge((event) => {
      wrapper.emitEvent(event);
    });
    wrapper.attachUiBridge(bridge);
    attachSessionStream(wrapper);
    // 看门狗登记必须在 start() 之前：session_start 阶段就可能已有事件到达。
    registerWatchSession(inner.sessionId as string, cwd);

    wrapper.start();

    // Bind after handing the wrapper back: an extension can block in
    // session_start (e.g. ctx.ui.input) and the caller must be able to return
    // the session id first so the renderer can show the dialog. `send`
    // (prompt path) awaits this promise.
    wrapper.setBinding(
      (async () => {
        if (typeof inner.bindExtensions === "function") {
          await inner.bindExtensions({
            uiContext: bridge as unknown as Parameters<NonNullable<AgentSessionLike["bindExtensions"]>>[0]["uiContext"],
            mode: "rpc",
          });
        }
        wrapper.applyAgentMode(agentMode);
        /**
         * 首轮预热必须在**装载落定之后**：applyAgentMode 之前 `state.tools` 还是
         * 默认集合（少 tool_search / tool_history_get），重放出的前缀与真实请求
         * 不一致 —— 写进缓存的是另一条前缀，白付一次写入。
         */
        if (cacheWarmingMode !== "off" && hasReplayablePrefix(inner as unknown as AgentSessionLike)) {
          const result = await warmPromptPrefix(inner as unknown as AgentSessionLike);
          wrapper.recordPrewarm(result);
          if (process.env.PIFORGE_DEBUG_CACHE === "1") {
            console.log("[cache] prewarm", result.sent ? "sent" : "skipped", result.reason);
          }
        }
      })(),
    );

    const realSessionId = inner.sessionId as string;

    wrapper.onDestroy(() => forgetWatchSession(realSessionId));

    // Ownership guard on the registry delete: destroy() is async and only runs
    // onDestroy callbacks after awaiting abort/unsubscribe, so a NEWER wrapper
    // started for the same id during that window can already be registered
    // here. An unconditional delete would evict the live wrapper (P2-4).
    wrapper.onDestroy(() => {
      if (registry.get(realSessionId) === wrapper) registry.delete(realSessionId);
    });
    registry.set(realSessionId, wrapper);

    return { session: wrapper, realSessionId };
  })().finally(() => locks.delete(sessionId));

  locks.set(sessionId, starting);
  return starting;
}
