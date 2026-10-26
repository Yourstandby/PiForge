import type { AgentMessage } from "@/lib/types";

/**
 * Events pushed from server to client via SSE. Each variant is discriminated
 * by `type`, so `switch (event.type)` narrows automatically — no `as` casts
 * needed at call sites.
 *
 * Note: the server-side `AgentEvent` in `agent-host/rpc-manager.ts` is intentionally
 * a separate, broader type — the server only forwards pi's events without
 * narrowing, and the two runtimes should not share a type.
 */
export type ExtensionUiRequestEvent = {
  type: "extension_ui_request";
  id: string;
  method: "confirm" | "select" | "input" | "editor";
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  timeout?: number;
};

export type ExtensionUiNotifyEvent = {
  type: "extension_ui_notify";
  message: string;
  notifyType?: "info" | "warning" | "error";
};

export type AgentEvent =
  | { type: "connected"; sessionId: string }
  | { type: "agent_start" }
  | { type: "agent_end" }
  | { type: "agent_settled" }
  | { type: "agent_error"; errorMessage: string }
  | { type: "message_start"; message: Partial<AgentMessage> }
  | { type: "message_update"; message: Partial<AgentMessage> }
  | { type: "message_end"; message: AgentMessage }
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      parentToolCallId?: string;
      args?: unknown;
    }
  | {
      /** 执行中的增量输出（bash 边跑边吐日志）：用于工具卡实时渲染。 */
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args?: unknown;
      partialResult?: unknown;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName?: string;
      parentToolCallId?: string;
      isError?: boolean;
      durationMs?: number;
      result?: unknown;
    }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; errorMessage?: string }
  | { type: "auto_retry_end" }
  | { type: "auto_compaction_start" }
  | { type: "compaction_start" }
  | {
      type: "auto_compaction_end";
      errorMessage?: string;
      aborted?: boolean;
      reason?: CompactionTriggerReason;
      result?: CompactionResultView;
    }
  | {
      type: "compaction_end";
      errorMessage?: string;
      aborted?: boolean;
      reason?: CompactionTriggerReason;
      result?: CompactionResultView;
    }
  | { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] }
  | { type: "session_info_changed"; name?: string }
  | {
      type: "follow_up_queue_update";
      revision: number;
      items: Array<{ id: string; message: string; attachmentCount: number; createdAt: number }>;
    }
  | ExtensionUiRequestEvent
  | ExtensionUiNotifyEvent;

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "failed";

export type CompactionTriggerReason = "manual" | "threshold" | "overflow";

/**
 * pi 在 `compaction_end.result` 里给出的两个数字（Host 原样转发）。
 * 只取「压前 / 压后估算」用于提示，其它字段不参与前端逻辑。
 */
export interface CompactionResultView {
  tokensBefore?: number;
  estimatedTokensAfter?: number;
}
/**
 * 快速重连阶段的上限。超过之后不再"放弃"，而是把状态标成 failed 并继续以 30s
 * 上限重连 —— 放弃重连等于把"流断了"变成"永远静默"：界面停在「正在思考…」，
 * 用户只能靠点停止触发 agent_end→reloadSession 才看见已经产出的内容。
 */
const MAX_FAST_RECONNECT_ATTEMPTS = 5;
const MAX_RECONNECT_DELAY_MS = 30_000;

export class AgentEventsManager {
  private eventSource: EventSource | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private agentRunning = false;
  private handleAgentEvent: ((event: AgentEvent) => void) | null = null;
  private statusChangeHandler:
    | ((status: ConnectionStatus, reconnectAttempts: number) => void)
    | null = null;
  private sid: string | null = null;
  private reconnectDelay: number;
  private reconnectAttempts = 0;
  private status: ConnectionStatus = "disconnected";
  /** 最近一次真正收到事件的时间戳；heartbeat 注释帧不更新它。 */
  private lastEventAt = 0;

  constructor(reconnectDelay = 1000) {
    this.reconnectDelay = reconnectDelay;
  }

  private setStatus(newStatus: ConnectionStatus) {
    this.status = newStatus;
    this.statusChangeHandler?.(newStatus, this.reconnectAttempts);
  }

  setStatusChangeHandler(
    handler: ((status: ConnectionStatus, reconnectAttempts: number) => void) | null
  ) {
    this.statusChangeHandler = handler;
  }

  /** 最近一次收到真实增量事件的时间戳（用于"连上了但一个字节都没来"的卡死判定）。 */
  getLastEventAt() {
    return this.lastEventAt;
  }

  /**
   * 立刻重连并清零退避计数。断流提示上的「立即重连」按钮、以及 agentRunning
   * 期间的外部看护都会调它。重连后 host 会从自己最后投递的序号续发，不丢增量。
   */
  retryNow() {
    if (!this.sid) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.lastEventAt = Date.now();
    this.connect(this.sid, true, this.agentRunning);
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  setAgentRunning(running: boolean) {
    this.agentRunning = running;
    if (!running) {
      this.disconnect();
      this.setStatus("disconnected");
    }
  }

  getAgentRunning() {
    return this.agentRunning;
  }

  setEventHandler(handler: (event: AgentEvent) => void) {
    this.handleAgentEvent = handler;
  }

  getEventSource() {
    return this.eventSource;
  }

  connect(sid: string, resetAttempts = true, expectRunning?: boolean) {
    this.sid = sid;
    if (resetAttempts) {
      this.reconnectAttempts = 0;
    }
    // Callers (use-agent-events.connectEvents) may fire connect() before the
    // React [agentRunning] effect has propagated setAgentRunning(true). Pass
    // expectRunning to express intent synchronously so an early onerror takes
    // the reconnect path instead of silently disconnecting (which left the UI
    // stuck on "Waiting for model…").
    if (expectRunning !== undefined) this.agentRunning = expectRunning;
    this.disconnect();
    this.setStatus("connecting");
    this.lastEventAt = Date.now();

    const es = new EventSource(`/api/agent/${encodeURIComponent(sid)}/events`);
    this.eventSource = es;

    es.onopen = () => {
      if (this.eventSource === es) {
        this.reconnectAttempts = 0;
        this.setStatus("connected");
      }
    };

    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as AgentEvent;
        this.lastEventAt = Date.now();
        // 开发期流式诊断：确认 SSE 是"一小块一小块"到达的。
        // F12 → Network → EventStream 应能与这里的日志一一对应。
        if (process.env.NODE_ENV !== "production" && event.type === "message_update") {
          const content = (event.message as { content?: unknown } | undefined)?.content;
          const text = Array.isArray(content)
            ? content
                .map((block) => (block as { text?: string })?.text ?? "")
                .join("")
            : "";
          console.debug("[sse] message_update", {
            at: Math.round(performance.now()),
            chars: text.length,
            tail: text.slice(-24),
          });
        }
        this.handleAgentEvent?.(event);
      } catch (err) {
        console.error("Failed to parse agent event", { data: e.data, error: err });
      }
    };

    es.onerror = () => {
      if (this.eventSource !== es) return;
      if (!this.agentRunning) {
        this.disconnect();
        this.setStatus("disconnected");
        return;
      }

      this.disconnect();
      this.reconnectAttempts++;
      // 超过快速阶段后状态标 failed（UI 会提示可点「立即重连」），但后台继续重连。
      this.setStatus(
        this.reconnectAttempts > MAX_FAST_RECONNECT_ATTEMPTS ? "failed" : "connecting"
      );
      // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 之后固定 30s。
      const delay = Math.min(
        MAX_RECONNECT_DELAY_MS,
        this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1)
      );
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (this.agentRunning && this.sid) {
          this.connect(this.sid, false);
        }
      }, delay);
    };
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  cleanup() {
    this.disconnect();
    this.sid = null;
    this.handleAgentEvent = null;
    this.setStatus("disconnected");
  }}
