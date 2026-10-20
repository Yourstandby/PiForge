/**
 * Per-session event streams for `agent.subscribe`.
 *
 * The host is the only process that sees pi's events. Every wrapper is attached
 * once at creation; events are buffered (bounded) and delivered to subscribers.
 *
 * Reconnect semantics: a subscription created without `fromSeq` resumes at the
 * sequence after the last event delivered to *any* subscriber. That is what
 * makes a Next.js restart seamless: the dead Next connection is gone, the
 * agent keeps running, and the next Next connection receives everything that
 * had not been sent yet.
 */
import { randomUUID } from "node:crypto";
import type { HostEventPayloads } from "../contract/events.ts";

export type StreamEvent = HostEventPayloads["agent.event"]["event"];

interface BufferedEvent {
  seq: number;
  event: StreamEvent;
  size: number;
}

interface SessionStream {
  sessionId: string;
  seq: number;
  buffer: BufferedEvent[];
  bufferBytes: number;
  lastDeliveredSeq: number;
  lastDeliveredAt: number;
  listeners: Map<string, SubscriptionState>;
  unsubscribe: () => void;
}

interface SubscriptionState {
  deliver: (event: StreamEvent, seq: number) => void;
  ready: boolean;
  replayEvents: BufferedEvent[];
  pending: BufferedEvent[];
}

export interface SessionStreamSource {
  readonly sessionId: string;
  onEvent(listener: (event: StreamEvent) => void): () => void;
  onDestroy(callback: () => void | Promise<void>): void;
}

export interface SessionSubscription {
  readonly id: string;
  readonly sessionId: string;
  readonly lastSeq: number;
  /** Deliver the replay buffer, then flush events that arrived in between. */
  activate(): void;
  unsubscribe(): void;
}

const MAX_BUFFER_EVENTS = 2_000;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

const streams = new Map<string, SessionStream>();

function trimBuffer(stream: SessionStream): void {
  while (
    stream.buffer.length > MAX_BUFFER_EVENTS ||
    (stream.bufferBytes > MAX_BUFFER_BYTES && stream.buffer.length > 1)
  ) {
    const removed = stream.buffer.shift();
    if (!removed) break;
    stream.bufferBytes -= removed.size;
  }
}

function deliverTo(
  stream: SessionStream,
  state: SubscriptionState,
  id: string,
  event: StreamEvent,
  seq: number,
): void {
  try {
    state.deliver(event, seq);
    if (seq > stream.lastDeliveredSeq) {
      stream.lastDeliveredSeq = seq;
      stream.lastDeliveredAt = Date.now();
    }
  } catch {
    // A dead subscriber must not take the stream down.
    stream.listeners.delete(id);
  }
}

/** Attach a wrapper exactly once. Idempotent for an already attached id. */
export function attachSessionStream(source: SessionStreamSource): void {
  if (streams.has(source.sessionId)) return;

  const stream: SessionStream = {
    sessionId: source.sessionId,
    seq: 0,
    buffer: [],
    bufferBytes: 0,
    lastDeliveredSeq: 0,
    lastDeliveredAt: 0,
    listeners: new Map(),
    unsubscribe: () => {},
  };
  streams.set(source.sessionId, stream);

  stream.unsubscribe = source.onEvent((event) => {
    stream.seq += 1;
    const size = JSON.stringify(event).length;
    const buffered: BufferedEvent = { seq: stream.seq, event, size };
    stream.buffer.push(buffered);
    stream.bufferBytes += size;
    trimBuffer(stream);

    for (const [id, state] of stream.listeners) {
      if (state.ready) {
        deliverTo(stream, state, id, event, buffered.seq);
      } else {
        state.pending.push(buffered);
      }
    }
  });

  source.onDestroy(() => {
    stream.unsubscribe();
    stream.listeners.clear();
    streams.delete(source.sessionId);
  });
}

export function hasSessionStream(sessionId: string): boolean {
  return streams.has(sessionId);
}

export function getSessionStreamSeq(sessionId: string): number | null {
  const stream = streams.get(sessionId);
  return stream ? stream.seq : null;
}

/**
 * Subscribe to a session stream. Returns null when the session is not attached
 * (unknown or already destroyed).
 */
export function subscribeSessionStream(
  sessionId: string,
  fromSeq: number | undefined,
  deliver: (event: StreamEvent, seq: number) => void,
): SessionSubscription | null {
  const stream = streams.get(sessionId);
  if (!stream) return null;

  const start = fromSeq ?? stream.lastDeliveredSeq + 1;
  const oldest = stream.buffer[0]?.seq ?? stream.seq + 1;
  const effectiveStart = Math.max(start, oldest);
  const replayEvents = stream.buffer.filter((entry) => entry.seq >= effectiveStart);

  const id = randomUUID();
  const state: SubscriptionState = {
    deliver,
    ready: false,
    replayEvents,
    pending: [],
  };
  stream.listeners.set(id, state);

  return {
    id,
    sessionId,
    lastSeq: stream.seq,
    activate(): void {
      const current = stream.listeners.get(id);
      if (!current) return;
      for (const entry of current.replayEvents) {
        deliverTo(stream, current, id, entry.event, entry.seq);
        if (!stream.listeners.has(id)) return;
      }
      current.replayEvents = [];
      current.ready = true;
      const pending = current.pending.sort((a, b) => a.seq - b.seq);
      current.pending = [];
      for (const entry of pending) {
        deliverTo(stream, current, id, entry.event, entry.seq);
        if (!stream.listeners.has(id)) return;
      }
    },
    unsubscribe(): void {
      stream.listeners.delete(id);
    },
  };
}

/** Test helper: drop all streams without touching wrappers. */
export function resetSessionStreamsForTest(): void {
  for (const stream of streams.values()) {
    stream.unsubscribe();
    stream.listeners.clear();
  }
  streams.clear();
}
