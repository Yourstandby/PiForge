/**
 * Pipe client for the Agent Host.
 *
 * Next.js route handlers are the only consumers. They call `call()` for RPC
 * and `subscribe()` for event streams; both are transport-agnostic per the
 * `contract/client.ts` interface.
 *
 * The singleton is stored on `globalThis` so Next.js hot reloads keep the
 * connection (and subscriptions) alive.
 */
import { connect, type Socket } from "node:net";
import type { AgentHostClient, AgentEventSubscription, HostSubscription } from "../contract/client.ts";
import {
  type GlobalEventPayloads,
  type GlobalTopic,
  type HostEventPayloads,
} from "../contract/events.ts";
import type { MethodName, Params, Result } from "../contract/methods.ts";
import {
  HANDSHAKE_TIMEOUT_MS,
  PROTOCOL_VERSION,
  type ClientFrame,
  type HostError,
  type HostErrorCode,
  type HostFrame,
} from "../contract/protocol.ts";
import { parseHostFrame } from "../contract/guards.ts";

const DEFAULT_CALL_TIMEOUT_MS = 15_000;
const RECONNECT_BASE_MS = 250;
const RECONNECT_MAX_MS = 5_000;
const MAX_EARLY_EVENTS = 32;

export class AgentHostError extends Error {
  readonly code: HostErrorCode;
  readonly retryable: boolean;

  constructor(error: HostError) {
    super(error.message);
    this.name = "AgentHostError";
    this.code = error.code;
    this.retryable = error.retryable ?? false;
  }
}

export function isAgentHostUnavailable(error: unknown): boolean {
  if (!(error instanceof AgentHostError)) return false;
  return (
    error.retryable ||
    error.code === "E_HOST_UNAVAILABLE" ||
    error.code === "E_PROTOCOL" ||
    error.code === "E_TIMEOUT" ||
    error.code === "E_BACKPRESSURE" ||
    error.code === "E_UNAUTHORIZED"
  );
}

function hostUnavailable(message: string): AgentHostError {
  return new AgentHostError({
    code: "E_HOST_UNAVAILABLE",
    message,
    retryable: true,
  });
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanup: () => void;
}

type HubListener = (payload: unknown, seq: number) => void;

interface TopicHub {
  listeners: Set<HubListener>;
  hostSubscriptionId: string | null;
  lastSeq: number;
  pending: Promise<void> | null;
}

type AgentListener = (event: HostEventPayloads["agent.event"]["event"], seq: number) => void;

interface AgentHub {
  listeners: Set<AgentListener>;
  hostSubscriptionId: string | null;
  lastSeq: number;
  pending: Promise<void> | null;
}

type HostSubscriptionRef =
  | { kind: "topic"; topic: GlobalTopic }
  | { kind: "agent"; sessionId: string };

interface EarlyEvent {
  payload: unknown;
  seq: number;
}

class PipeAgentHostClient implements AgentHostClient {
  private readonly endpoint: string | null;
  private readonly token: string | null;
  private socket: Socket | null = null;
  private currentStatus: AgentHostClient["status"] = "idle";
  private nextId = 0;
  private readonly pending = new Map<number, PendingCall>();
  private readonly statusListeners = new Set<(status: AgentHostClient["status"]) => void>();
  private readonly hubs = new Map<GlobalTopic, TopicHub>();
  private readonly agentHubs = new Map<string, AgentHub>();
  private readonly hostSubscriptions = new Map<string, HostSubscriptionRef>();
  private readonly earlyEvents = new Map<string, EarlyEvent[]>();
  private connectPromise: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private closed = false;

  constructor() {
    this.endpoint = process.env.PIFORGE_AGENT_ENDPOINT?.trim() || null;
    this.token = process.env.PIFORGE_AGENT_TOKEN?.trim() || null;
  }

  get status(): AgentHostClient["status"] {
    return this.currentStatus;
  }

  onStatusChange(listener: (status: AgentHostClient["status"]) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private setStatus(next: AgentHostClient["status"]): void {
    if (this.currentStatus === next) return;
    this.currentStatus = next;
    for (const listener of [...this.statusListeners]) {
      try {
        listener(next);
      } catch (error) {
        console.error("agent-host status listener failed:", error);
      }
    }
  }

  async call<M extends MethodName>(
    method: M,
    params: Params<M>,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<Result<M>> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    if (options.signal?.aborted) {
      throw new AgentHostError({ code: "E_TIMEOUT", message: "Request aborted", retryable: true });
    }
    await this.ensureConnected(timeoutMs);

    return new Promise<Result<M>>((resolve, reject) => {
      const id = ++this.nextId;
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const fail = (error: unknown) => {
        if (!this.pending.delete(id)) return;
        cleanup();
        reject(error);
      };
      const timer = setTimeout(() => {
        fail(
          new AgentHostError({
            code: "E_TIMEOUT",
            message: `${method} timed out after ${timeoutMs}ms`,
            retryable: true,
          }),
        );
      }, timeoutMs);
      const onAbort = () => {
        fail(new AgentHostError({ code: "E_TIMEOUT", message: "Request aborted", retryable: true }));
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });

      this.pending.set(id, {
        resolve: (value) => resolve(value as Result<M>),
        reject,
        timer,
        cleanup,
      });

      if (!this.write({
        kind: "req",
        id,
        method,
        params: params as unknown as Record<string, unknown>,
      })) {
        fail(hostUnavailable("Agent Host connection is not writable"));
      }
    });
  }

  async subscribe<T extends GlobalTopic>(
    topic: T,
    handler: (payload: GlobalEventPayloads[T], seq: number) => void,
  ): Promise<HostSubscription> {
    let hub = this.hubs.get(topic);
    if (!hub) {
      hub = { listeners: new Set(), hostSubscriptionId: null, lastSeq: 0, pending: null };
      this.hubs.set(topic, hub);
    }
    const listener = handler as HubListener;
    hub.listeners.add(listener);

    await this.ensureTopicSubscription(topic);

    const topicHub = hub;
    return {
      get id(): string {
        return topicHub.hostSubscriptionId ?? "";
      },
      get lastSeq(): number {
        return topicHub.lastSeq;
      },
      close: (): void => {
        topicHub.listeners.delete(listener);
        if (topicHub.listeners.size > 0) return;
        this.hubs.delete(topic);
        const subscriptionId = topicHub.hostSubscriptionId;
        topicHub.hostSubscriptionId = null;
        if (subscriptionId) {
          this.hostSubscriptions.delete(subscriptionId);
          if (this.currentStatus === "ready") {
            void this.call("host.unsubscribe", { subscriptionId }).catch(() => {
              // Host may already be gone; the subscription dies with the pipe.
            });
          }
        }
      },
    };
  }

  async subscribeAgent(
    sessionId: string,
    handler: AgentListener,
    options: { fromSeq?: number } = {},
  ): Promise<AgentEventSubscription> {
    let hub = this.agentHubs.get(sessionId);
    if (!hub) {
      hub = { listeners: new Set(), hostSubscriptionId: null, lastSeq: 0, pending: null };
      this.agentHubs.set(sessionId, hub);
    }
    hub.listeners.add(handler);

    try {
      await this.ensureAgentSubscription(sessionId, options.fromSeq);
    } catch (error) {
      hub.listeners.delete(handler);
      if (hub.listeners.size === 0) this.agentHubs.delete(sessionId);
      throw error;
    }

    const agentHub = hub;
    return {
      get id(): string {
        return agentHub.hostSubscriptionId ?? "";
      },
      get sessionId(): string {
        return sessionId;
      },
      get lastSeq(): number {
        return agentHub.lastSeq;
      },
      close: (): void => {
        agentHub.listeners.delete(handler);
        if (agentHub.listeners.size > 0) return;
        this.agentHubs.delete(sessionId);
        const subscriptionId = agentHub.hostSubscriptionId;
        agentHub.hostSubscriptionId = null;
        if (subscriptionId) {
          this.hostSubscriptions.delete(subscriptionId);
          if (this.currentStatus === "ready") {
            void this.call("agent.unsubscribe", { subscriptionId }).catch(() => {
              // Host may already be gone; the subscription dies with the pipe.
            });
          }
        }
      },
    };
  }

  close(): void {
    this.closed = true;
    this.setStatus("closed");
    this.clearReconnectTimer();
    this.failPending(hostUnavailable("Agent Host client closed"));
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.destroy();
    } catch {
      // Already gone.
    }
    this.hubs.clear();
    this.agentHubs.clear();
    this.hostSubscriptions.clear();
    this.earlyEvents.clear();
  }

  private async ensureTopicSubscription(topic: GlobalTopic): Promise<void> {
    const hub = this.hubs.get(topic);
    if (!hub || hub.listeners.size === 0) return;
    if (hub.hostSubscriptionId) return;
    if (hub.pending) return hub.pending;

    const pending = (async () => {
      await this.ensureConnected(DEFAULT_CALL_TIMEOUT_MS);
      if (hub.hostSubscriptionId) return;
      const { subscriptionId } = await this.call("host.subscribe", { topics: [topic] });
      hub.hostSubscriptionId = subscriptionId;
      this.hostSubscriptions.set(subscriptionId, { kind: "topic", topic });
      const early = this.earlyEvents.get(subscriptionId);
      if (early) {
        this.earlyEvents.delete(subscriptionId);
        for (const event of early) this.dispatch(topic, event.payload, event.seq);
      }
    })();
    hub.pending = pending;
    try {
      await pending;
    } finally {
      if (hub.pending === pending) hub.pending = null;
    }
  }

  private async ensureAgentSubscription(sessionId: string, fromSeq?: number): Promise<void> {
    const hub = this.agentHubs.get(sessionId);
    if (!hub || hub.listeners.size === 0) return;
    if (hub.hostSubscriptionId) return;
    if (hub.pending) return hub.pending;

    const pending = (async () => {
      await this.ensureConnected(DEFAULT_CALL_TIMEOUT_MS);
      if (hub.hostSubscriptionId) return;
      const subscribeResult = await this.call(
        "agent.subscribe",
        fromSeq === undefined ? { sessionId } : { sessionId, fromSeq },
      );
      hub.hostSubscriptionId = subscribeResult.subscriptionId;
      hub.lastSeq = subscribeResult.lastSeq;
      this.hostSubscriptions.set(subscribeResult.subscriptionId, { kind: "agent", sessionId });
      const early = this.earlyEvents.get(subscribeResult.subscriptionId);
      if (early) {
        this.earlyEvents.delete(subscribeResult.subscriptionId);
        for (const event of early) {
          if (isStreamEvent(event.payload)) {
            this.dispatchAgent(sessionId, event.payload, event.seq);
          }
        }
      }
    })();
    hub.pending = pending;
    try {
      await pending;
    } finally {
      if (hub.pending === pending) hub.pending = null;
    }
  }

  private async ensureConnected(timeoutMs: number): Promise<void> {
    if (this.closed) throw hostUnavailable("Agent Host client is closed");
    if (!this.endpoint || !this.token) {
      throw hostUnavailable("PIFORGE_AGENT_ENDPOINT / PIFORGE_AGENT_TOKEN are not set");
    }
    if (this.currentStatus === "ready" && this.socket) return;
    if (!this.connectPromise) {
      this.connectPromise = this.openConnection().finally(() => {
        this.connectPromise = null;
      });
    }
    await withTimeout(this.connectPromise, timeoutMs);
  }

  private openConnection(): Promise<void> {
    const endpoint = this.endpoint;
    const token = this.token;
    if (!endpoint || !token) {
      return Promise.reject(hostUnavailable("Agent Host endpoint is not configured"));
    }

    this.clearReconnectTimer();
    this.setStatus("connecting");

    return new Promise<void>((resolve, reject) => {
      const socket = connect(endpoint);
      this.socket = socket;
      socket.setNoDelay(true);

      let handshaken = false;
      let finished = false;
      let buffer: Buffer = Buffer.alloc(0);
      const handshakeTimer = setTimeout(() => {
        fail(
          new AgentHostError({
            code: "E_TIMEOUT",
            message: "Agent Host handshake timed out",
            retryable: true,
          }),
        );
      }, HANDSHAKE_TIMEOUT_MS);

      const fail = (error: AgentHostError) => {
        if (finished) return;
        finished = true;
        clearTimeout(handshakeTimer);
        this.socket = null;
        this.setStatus("idle");
        try {
          socket.destroy();
        } catch {
          // Already gone.
        }
        reject(error);
      };

      socket.once("connect", () => {
        this.write({
          kind: "hello",
          protocolVersion: PROTOCOL_VERSION,
          token,
          client: { pid: process.pid, role: "next-server" },
        });
      });

      socket.on("data", (chunk: Buffer) => {
        if (!handshaken && finished) return;
        buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
        let newlineIndex = buffer.indexOf(0x0a);
        while (newlineIndex !== -1) {
          const line = buffer.subarray(0, newlineIndex).toString("utf8");
          buffer = buffer.subarray(newlineIndex + 1);
          if (line.trim().length > 0) {
            const frame = parseHostFrame(line);
            if (!frame) {
              if (!handshaken) {
                fail(hostUnavailable("Malformed handshake response"));
                return;
              }
            } else if (!handshaken) {
              if (frame.kind === "hello_ok") {
                handshaken = true;
                finished = true;
                clearTimeout(handshakeTimer);
                this.setStatus("ready");
                this.reconnectAttempts = 0;
                resolve();
                this.resubscribeAll();
              } else if (frame.kind === "hello_error") {
                fail(new AgentHostError(frame.error));
                return;
              } else {
                fail(hostUnavailable("Unexpected frame during handshake"));
                return;
              }
            } else {
              this.handleFrame(frame);
            }
          }
          newlineIndex = buffer.indexOf(0x0a);
        }
      });

      socket.once("error", (error) => {
        const wrapped = hostUnavailable(error.message);
        if (!handshaken) fail(wrapped);
        else this.handleDisconnect();
      });

      socket.once("close", () => {
        if (!handshaken) {
          fail(hostUnavailable("Agent Host connection closed during handshake"));
          return;
        }
        this.handleDisconnect();
      });
    });
  }

  private handleFrame(frame: HostFrame): void {
    switch (frame.kind) {
      case "res": {
        const pending = this.pending.get(frame.id);
        if (!pending) return;
        this.pending.delete(frame.id);
        pending.cleanup();
        if (frame.ok) pending.resolve(frame.result);
        else pending.reject(new AgentHostError(frame.error));
        return;
      }
      case "evt": {
        const hostSubscription = this.hostSubscriptions.get(frame.subscriptionId);
        if (hostSubscription?.kind === "topic") {
          this.dispatch(hostSubscription.topic, frame.payload, frame.seq);
          return;
        }
        if (hostSubscription?.kind === "agent") {
          const payload = frame.payload as { sessionId?: unknown; event?: unknown } | null;
          if (payload && typeof payload === "object" && isStreamEvent(payload.event)) {
            this.dispatchAgent(hostSubscription.sessionId, payload.event, frame.seq);
          }
          return;
        }
        const early = this.earlyEvents.get(frame.subscriptionId) ?? [];
        if (early.length < MAX_EARLY_EVENTS) {
          early.push({ payload: frame.payload, seq: frame.seq });
          this.earlyEvents.set(frame.subscriptionId, early);
        }
        return;
      }
      case "ping":
        this.write({ kind: "pong", nonce: frame.nonce });
        return;
      default:
        return;
    }
  }

  private dispatch(topic: GlobalTopic, payload: unknown, seq: number): void {
    const hub = this.hubs.get(topic);
    if (!hub) return;
    hub.lastSeq = seq;
    for (const listener of [...hub.listeners]) {
      try {
        listener(payload, seq);
      } catch (error) {
        console.error("agent-host event listener failed:", error);
      }
    }
  }

  private dispatchAgent(
    sessionId: string,
    event: HostEventPayloads["agent.event"]["event"],
    seq: number,
  ): void {
    const hub = this.agentHubs.get(sessionId);
    if (!hub) return;
    hub.lastSeq = seq;
    for (const listener of [...hub.listeners]) {
      try {
        listener(event, seq);
      } catch (error) {
        console.error("agent-host agent listener failed:", error);
      }
    }
  }

  private resubscribeAll(): void {
    for (const topic of [...this.hubs.keys()]) {
      const hub = this.hubs.get(topic);
      if (!hub || hub.listeners.size === 0 || hub.hostSubscriptionId || hub.pending) continue;
      void this.ensureTopicSubscription(topic).catch((error) => {
        console.error(`agent-host resubscribe failed (${topic}):`, error);
      });
    }
    for (const sessionId of [...this.agentHubs.keys()]) {
      const hub = this.agentHubs.get(sessionId);
      if (!hub || hub.listeners.size === 0 || hub.hostSubscriptionId || hub.pending) continue;
      void this.ensureAgentSubscription(sessionId).catch((error) => {
        console.error(`agent-host resubscribe failed (${sessionId}):`, error);
      });
    }
  }

  private handleDisconnect(): void {
    if (this.closed) return;
    this.socket = null;
    this.setStatus("reconnecting");
    this.hostSubscriptions.clear();
    this.earlyEvents.clear();
    for (const hub of this.hubs.values()) {
      hub.hostSubscriptionId = null;
      hub.pending = null;
    }
    for (const hub of this.agentHubs.values()) {
      hub.hostSubscriptionId = null;
      hub.pending = null;
    }
    this.failPending(hostUnavailable("Agent Host connection lost"));
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const hasListeners =
      [...this.hubs.values()].some((hub) => hub.listeners.size > 0) ||
      [...this.agentHubs.values()].some((hub) => hub.listeners.size > 0);
    if (!hasListeners) {
      this.setStatus("idle");
      return;
    }
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed) return;
      void this.ensureConnected(RECONNECT_MAX_MS).catch(() => {
        this.scheduleReconnect();
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private failPending(error: AgentHostError): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.cleanup();
      pending.reject(error);
    }
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private write(frame: ClientFrame): boolean {
    const socket = this.socket;
    if (!socket || socket.destroyed || !socket.writable) return false;
    try {
      socket.write(`${JSON.stringify(frame)}\n`);
      return true;
    } catch {
      return false;
    }
  }
}

function isStreamEvent(value: unknown): value is HostEventPayloads["agent.event"]["event"] {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new AgentHostError({
          code: "E_TIMEOUT",
          message: `Agent Host did not become ready within ${timeoutMs}ms`,
          retryable: true,
        }),
      );
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

declare global {
  var __piforgeAgentHostClient: PipeAgentHostClient | undefined;
}

export function getAgentHostClient(): AgentHostClient {
  if (!globalThis.__piforgeAgentHostClient) {
    globalThis.__piforgeAgentHostClient = new PipeAgentHostClient();
  }
  return globalThis.__piforgeAgentHostClient;
}

/** Health probe used by `/api/health`; never throws. */
export async function probeAgentHost(timeoutMs = 1_200): Promise<"ok" | "down"> {
  try {
    const result = await getAgentHostClient().call("host.health", {}, { timeoutMs });
    return result.ok ? "ok" : "down";
  } catch {
    return "down";
  }
}

/**
 * Best-effort notification that auth/models.json changed. Running sessions
 * reload their resources on the next prompt so a fresh login takes effect.
 */
export function notifyAgentHostModelsChanged(): void {
  void getAgentHostClient()
    .call("models.refresh", {})
    .catch(() => {
      // Host down: the change is still on disk for the next session start.
    });
}
