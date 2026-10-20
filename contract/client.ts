import type {
  GlobalEventPayloads,
  GlobalTopic,
  HostEventPayloads,
} from "./events.ts";
import type { MethodName, Params, Result } from "./methods.ts";

export type AgentHostClientStatus =
  | "idle"
  | "connecting"
  | "ready"
  | "reconnecting"
  | "closed";

export interface HostSubscription {
  readonly id: string;
  /** Last sequence number delivered to the handler. */
  readonly lastSeq: number;
  close(): void;
}

export interface AgentEventSubscription {
  readonly id: string;
  readonly sessionId: string;
  readonly lastSeq: number;
  close(): void;
}

/**
 * Typed façade used by the Next.js route adapters.
 *
 * The call sites must not know whether events arrive through a named pipe, a
 * Unix socket, or the in-process transport used by contract tests.
 */
export interface AgentHostClient {
  readonly status: AgentHostClientStatus;

  call<M extends MethodName>(
    method: M,
    params: Params<M>,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<Result<M>>;

  subscribe<T extends GlobalTopic>(
    topic: T,
    handler: (payload: GlobalEventPayloads[T], seq: number) => void,
  ): Promise<HostSubscription>;

  /** Subscribe to one agent session's event stream (raw pi events). */
  subscribeAgent(
    sessionId: string,
    handler: (event: HostEventPayloads["agent.event"]["event"], seq: number) => void,
    options?: { fromSeq?: number },
  ): Promise<AgentEventSubscription>;

  close(): void;

  /** Observe transport status transitions (used by SSE routes to close/reconnect). */
  onStatusChange(listener: (status: AgentHostClientStatus) => void): () => void;
}
