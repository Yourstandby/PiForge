import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import {
  HANDSHAKE_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  hostError,
  type ClientFrame,
  type HostErrorCode,
  type HostFrame,
} from "../contract/protocol.ts";
import {
  GLOBAL_TOPIC_EVENT,
  type GlobalTopic,
  type HostEventPayloads,
  type HostEventTopic,
} from "../contract/events.ts";
import { parseClientFrame } from "../contract/guards.ts";
import type { HostHealth } from "../contract/methods.ts";
import {
  listManagedProcesses,
  onManagedProcessesChange,
  removeManagedProcessEntry,
  restartManagedProcess,
  sendManagedProcessInput,
  startManagedProcess,
  stopAllManagedProcesses,
  stopManagedProcess,
} from "./managed-processes.ts";
import {
  clearTerminalLog,
  finishShellBlock,
  listTerminalBlocks,
  onTerminalLogChange,
  setShellOutput,
  startShellBlock,
} from "./terminal-log.ts";

export interface AgentHostServerOptions {
  /** Named pipe path (Windows) or Unix domain socket path. */
  endpoint: string;
  /** Launch token shared with the client through the environment. */
  token: string;
  log?: (message: string) => void;
  onReady?: (endpoint: string) => void;
  onFatal?: (error: Error) => void;
}

export interface AgentHostServer {
  readonly endpoint: string;
  start(): Promise<void>;
  close(): Promise<void>;
  health(): HostHealth;
}

interface ConnectionState {
  socket: Socket;
  buffer: Buffer;
  handshaken: boolean;
  closed: boolean;
  handshakeTimer: NodeJS.Timeout | null;
  heartbeatTimer: NodeJS.Timeout | null;
  lastPongAt: number;
  pingNonce: number;
}

interface Subscription {
  id: string;
  connection: ConnectionState;
  topics: Set<GlobalTopic>;
  seq: number;
}

const DEFAULT_LOG = (message: string) => {
  console.log(`[agent-host] ${message}`);
};

/** Coalesce chatty process/terminal output into at most ~4 events/second. */
const BROADCAST_INTERVAL_MS = 250;

const GLOBAL_TOPICS: readonly GlobalTopic[] = ["processes", "terminal"];

function tokensMatch(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function prepareEndpoint(endpoint: string): void {
  if (process.platform === "win32") return;
  mkdirSync(path.dirname(endpoint), { recursive: true, mode: 0o700 });
  // The endpoint is generated once per app run and reused across host
  // restarts. A leftover socket file therefore belongs to a dead instance
  // (the app holds a single-instance lock); remove it before listening.
  if (existsSync(endpoint)) {
    try {
      unlinkSync(endpoint);
    } catch {
      // Best effort: listen() below will surface a real error.
    }
  }
}

function readString(params: Record<string, unknown>, key: string): string | null {
  const value = params[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readOptionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" ? value : undefined;
}

export function createAgentHostServer(options: AgentHostServerOptions): AgentHostServer {
  const log = options.log ?? DEFAULT_LOG;
  const startedAt = Date.now();
  const sockets = new Set<ConnectionState>();
  const subscriptions = new Map<string, Subscription>();
  const broadcastTimers = new Map<GlobalTopic, NodeJS.Timeout>();
  const lastBroadcastAt = new Map<GlobalTopic, number>();
  let server: Server | null = null;
  let closing: Promise<void> | null = null;
  let connections = 0;
  let handshaked = 0;
  let requests = 0;
  let listenersDetached = false;

  const offProcessesChange = onManagedProcessesChange(() => scheduleBroadcast("processes"));
  const offTerminalChange = onTerminalLogChange(() => scheduleBroadcast("terminal"));

  function writeFrame(state: ConnectionState, frame: HostFrame): boolean {
    if (state.closed || state.socket.destroyed || !state.socket.writable) return false;
    try {
      state.socket.write(`${JSON.stringify(frame)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  function dropSubscription(subscription: Subscription): void {
    subscriptions.delete(subscription.id);
  }

  function sendEvent(
    subscription: Subscription,
    topic: GlobalTopic,
    payload: HostEventPayloads[HostEventTopic],
  ): void {
    subscription.seq += 1;
    const ok = writeFrame(subscription.connection, {
      kind: "evt",
      subscriptionId: subscription.id,
      seq: subscription.seq,
      topic: GLOBAL_TOPIC_EVENT[topic],
      payload,
    });
    if (!ok) dropSubscription(subscription);
  }

  function subscribersFor(topic: GlobalTopic): Subscription[] {
    const result: Subscription[] = [];
    for (const subscription of subscriptions.values()) {
      if (subscription.topics.has(topic)) result.push(subscription);
    }
    return result;
  }

  function emitTopicSnapshot(topic: GlobalTopic): void {
    const targets = subscribersFor(topic);
    if (targets.length === 0) return;
    lastBroadcastAt.set(topic, Date.now());
    if (topic === "processes") {
      const payload: HostEventPayloads["processes.changed"] = {
        processes: listManagedProcesses(),
      };
      for (const subscription of targets) sendEvent(subscription, topic, payload);
      return;
    }
    const payload: HostEventPayloads["terminal.changed"] = {
      blocks: listTerminalBlocks(),
    };
    for (const subscription of targets) sendEvent(subscription, topic, payload);
  }

  function scheduleBroadcast(topic: GlobalTopic): void {
    if (listenersDetached || subscribersFor(topic).length === 0) return;
    if (broadcastTimers.has(topic)) return;
    const elapsed = Date.now() - (lastBroadcastAt.get(topic) ?? 0);
    const wait = Math.max(0, BROADCAST_INTERVAL_MS - elapsed);
    const timer = setTimeout(() => {
      broadcastTimers.delete(topic);
      if (closing) return;
      emitTopicSnapshot(topic);
    }, wait);
    timer.unref?.();
    broadcastTimers.set(topic, timer);
  }

  function clearBroadcastTimers(): void {
    for (const timer of broadcastTimers.values()) clearTimeout(timer);
    broadcastTimers.clear();
  }

  function closeConnection(state: ConnectionState, reason: string): void {
    if (state.closed) return;
    state.closed = true;
    if (state.handshakeTimer) clearTimeout(state.handshakeTimer);
    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
    state.handshakeTimer = null;
    state.heartbeatTimer = null;
    sockets.delete(state);
    for (const [id, subscription] of subscriptions) {
      if (subscription.connection === state) subscriptions.delete(id);
    }
    try {
      state.socket.end();
    } catch {
      // Already gone.
    }
    if (state.handshaken) log(`connection closed (${reason})`);
  }

  function fail(state: ConnectionState, id: number | null, code: HostErrorCode, message: string, close = false): void {
    const error = hostError(code, message);
    if (id === null) {
      writeFrame(state, { kind: "hello_error", error });
    } else {
      writeFrame(state, { kind: "res", id, ok: false, error });
    }
    if (close) closeConnection(state, code);
  }

  function result(state: ConnectionState, id: number, value: unknown): void {
    writeFrame(state, { kind: "res", id, ok: true, result: value });
  }

  function respond<T>(
    state: ConnectionState,
    id: number,
    promise: Promise<T>,
    map: (value: T) => unknown,
  ): void {
    promise
      .then((value) => result(state, id, map(value)))
      .catch((error: unknown) => {
        fail(state, id, "INTERNAL", error instanceof Error ? error.message : String(error));
      });
  }

  function startHeartbeat(state: ConnectionState): void {
    state.lastPongAt = Date.now();
    state.heartbeatTimer = setInterval(() => {
      if (state.closed) return;
      if (Date.now() - state.lastPongAt > HEARTBEAT_TIMEOUT_MS) {
        log(`heartbeat timeout (pid=${state.socket.remotePort ?? "?"})`);
        state.socket.destroy();
        closeConnection(state, "heartbeat timeout");
        return;
      }
      state.pingNonce += 1;
      writeFrame(state, { kind: "ping", nonce: state.pingNonce });
    }, HEARTBEAT_INTERVAL_MS);
    state.heartbeatTimer.unref?.();
  }

  function handleHello(state: ConnectionState, frame: Extract<ClientFrame, { kind: "hello" }>): void {
    if (frame.protocolVersion !== PROTOCOL_VERSION) {
      fail(state, null, "E_PROTOCOL", `Protocol mismatch: host=${PROTOCOL_VERSION} client=${frame.protocolVersion}`, true);
      return;
    }
    if (!tokensMatch(frame.token, options.token)) {
      fail(state, null, "E_UNAUTHORIZED", "Invalid launch token", true);
      return;
    }
    state.handshaken = true;
    handshaked += 1;
    if (state.handshakeTimer) clearTimeout(state.handshakeTimer);
    state.handshakeTimer = null;
    writeFrame(state, {
      kind: "hello_ok",
      protocolVersion: PROTOCOL_VERSION,
      hostPid: process.pid,
      startedAt,
    });
    startHeartbeat(state);
    log(`client connected (pid=${frame.client.pid}, role=${frame.client.role})`);
  }

  function registerSubscription(
    state: ConnectionState,
    id: number,
    params: Record<string, unknown>,
  ): void {
    const rawTopics = params.topics;
    if (!Array.isArray(rawTopics) || rawTopics.length === 0) {
      fail(state, id, "E_INVALID_PARAMS", "topics must be a non-empty array");
      return;
    }
    const topics = new Set<GlobalTopic>();
    for (const value of rawTopics) {
      if (typeof value !== "string" || !GLOBAL_TOPICS.includes(value as GlobalTopic)) {
        fail(state, id, "E_INVALID_PARAMS", `Unknown topic: ${String(value)}`);
        return;
      }
      topics.add(value as GlobalTopic);
    }

    const subscription: Subscription = {
      id: randomUUID(),
      connection: state,
      topics,
      seq: 0,
    };
    subscriptions.set(subscription.id, subscription);
    result(state, id, { subscriptionId: subscription.id });
    // Initial snapshot after the response so the client can map the id first.
    for (const topic of topics) emitTopicSnapshotTo(subscription, topic);
  }

  function emitTopicSnapshotTo(subscription: Subscription, topic: GlobalTopic): void {
    if (topic === "processes") {
      sendEvent(subscription, topic, { processes: listManagedProcesses() });
      return;
    }
    sendEvent(subscription, topic, { blocks: listTerminalBlocks() });
  }

  function handleRequest(state: ConnectionState, frame: Extract<ClientFrame, { kind: "req" }>): void {
    requests += 1;
    const params = frame.params;

    switch (frame.method) {
      case "host.health": {
        result(state, frame.id, health());
        return;
      }
      case "host.shutdown": {
        const drainMs = params.drainMs;
        if (drainMs !== undefined && (typeof drainMs !== "number" || !Number.isFinite(drainMs) || drainMs < 0 || drainMs > 60_000)) {
          fail(state, frame.id, "E_INVALID_PARAMS", "drainMs must be a number between 0 and 60000");
          return;
        }
        const stoppedProcesses = listManagedProcesses().filter((entry) => entry.status === "running").length;
        result(state, frame.id, { closedSessions: 0, stoppedProcesses });
        log(`shutdown requested over RPC (drainMs=${drainMs ?? 0})`);
        setTimeout(() => {
          void close();
        }, 25);
        return;
      }
      case "host.subscribe": {
        registerSubscription(state, frame.id, params);
        return;
      }
      case "host.unsubscribe": {
        const subscriptionId = readString(params, "subscriptionId");
        if (!subscriptionId) {
          fail(state, frame.id, "E_INVALID_PARAMS", "subscriptionId is required");
          return;
        }
        subscriptions.delete(subscriptionId);
        result(state, frame.id, { ok: true });
        return;
      }
      case "processes.list": {
        result(state, frame.id, { processes: listManagedProcesses() });
        return;
      }
      case "processes.start": {
        const cwd = readString(params, "cwd");
        const command = readString(params, "command");
        if (!cwd || !command) {
          fail(state, frame.id, "E_INVALID_PARAMS", "cwd and command are required");
          return;
        }
        try {
          const process = startManagedProcess({
            cwd,
            command,
            name: readOptionalString(params, "name"),
          });
          result(state, frame.id, { process });
        } catch (error) {
          fail(state, frame.id, "E_INVALID_PARAMS", error instanceof Error ? error.message : String(error));
        }
        return;
      }
      case "processes.stop": {
        const id = readString(params, "id");
        if (!id) {
          fail(state, frame.id, "E_INVALID_PARAMS", "id is required");
          return;
        }
        respond(state, frame.id, stopManagedProcess(id), (ok) => ({ ok }));
        return;
      }
      case "processes.restart": {
        const id = readString(params, "id");
        if (!id) {
          fail(state, frame.id, "E_INVALID_PARAMS", "id is required");
          return;
        }
        respond(state, frame.id, restartManagedProcess(id), (process) => ({ process }));
        return;
      }
      case "processes.remove": {
        const id = readString(params, "id");
        if (!id) {
          fail(state, frame.id, "E_INVALID_PARAMS", "id is required");
          return;
        }
        respond(state, frame.id, removeManagedProcessEntry(id), (ok) => ({ ok }));
        return;
      }
      case "processes.stdin": {
        const id = readString(params, "id");
        const input = readOptionalString(params, "input");
        if (!id || input === undefined) {
          fail(state, frame.id, "E_INVALID_PARAMS", "id and input are required");
          return;
        }
        result(state, frame.id, { ok: sendManagedProcessInput(id, input) });
        return;
      }
      case "terminal.list": {
        result(state, frame.id, { blocks: listTerminalBlocks() });
        return;
      }
      case "terminal.clear": {
        clearTerminalLog();
        result(state, frame.id, { ok: true });
        return;
      }
      case "terminal.shellStart": {
        const id = readString(params, "id");
        const command = readString(params, "command");
        if (!id || !command) {
          fail(state, frame.id, "E_INVALID_PARAMS", "id and command are required");
          return;
        }
        const cwdParam = params.cwd;
        if (cwdParam !== undefined && cwdParam !== null && typeof cwdParam !== "string") {
          fail(state, frame.id, "E_INVALID_PARAMS", "cwd must be a string or null");
          return;
        }
        startShellBlock({
          id,
          command,
          cwd: typeof cwdParam === "string" ? cwdParam : null,
        });
        result(state, frame.id, { ok: true });
        return;
      }
      case "terminal.shellUpdate": {
        const id = readString(params, "id");
        const text = readOptionalString(params, "text");
        if (!id || text === undefined) {
          fail(state, frame.id, "E_INVALID_PARAMS", "id and text are required");
          return;
        }
        setShellOutput(id, text);
        result(state, frame.id, { ok: true });
        return;
      }
      case "terminal.shellFinish": {
        const id = readString(params, "id");
        if (!id) {
          fail(state, frame.id, "E_INVALID_PARAMS", "id is required");
          return;
        }
        const status = params.status;
        if (status !== undefined && status !== "running" && status !== "ok" && status !== "error") {
          fail(state, frame.id, "E_INVALID_PARAMS", "status must be running | ok | error");
          return;
        }
        const text = readOptionalString(params, "text");
        const block = finishShellBlock({
          id,
          ...(text !== undefined ? { text } : {}),
          ...(status !== undefined ? { status } : {}),
        });
        result(state, frame.id, { ok: block !== null });
        return;
      }
      default:
        fail(state, frame.id, "E_UNKNOWN_METHOD", `Unknown method: ${frame.method}`);
    }
  }

  function handleFrame(state: ConnectionState, frame: ClientFrame): void {
    if (!state.handshaken) {
      if (frame.kind !== "hello") {
        fail(state, null, "E_PROTOCOL", "Handshake required", true);
        return;
      }
      handleHello(state, frame);
      return;
    }

    switch (frame.kind) {
      case "pong":
        state.lastPongAt = Date.now();
        return;
      case "cancel":
        // Long-running methods are resolved by their own handlers (stop /
        // restart); per-request cancellation lands with the Pi SDK migration.
        return;
      case "req":
        handleRequest(state, frame);
        return;
      case "hello":
        fail(state, null, "E_PROTOCOL", "Already handshaken", true);
        return;
    }
  }

  function handleConnection(socket: Socket): void {
    connections += 1;
    socket.setNoDelay(true);
    const state: ConnectionState = {
      socket,
      buffer: Buffer.alloc(0),
      handshaken: false,
      closed: false,
      handshakeTimer: null,
      heartbeatTimer: null,
      lastPongAt: Date.now(),
      pingNonce: 0,
    };
    sockets.add(state);

    state.handshakeTimer = setTimeout(() => {
      if (!state.handshaken) closeConnection(state, "handshake timeout");
    }, HANDSHAKE_TIMEOUT_MS);
    state.handshakeTimer.unref?.();

    socket.on("data", (chunk: Buffer) => {
      if (state.closed) return;
      state.buffer = state.buffer.length === 0 ? chunk : Buffer.concat([state.buffer, chunk]);

      // A huge frame without a newline must not be buffered forever.
      if (state.buffer.length > MAX_FRAME_BYTES && state.buffer.indexOf(0x0a) === -1) {
        log(`frame exceeds ${MAX_FRAME_BYTES} bytes; dropping connection`);
        socket.destroy();
        closeConnection(state, "frame too large");
        return;
      }

      let newlineIndex = state.buffer.indexOf(0x0a);
      while (newlineIndex !== -1) {
        const line = state.buffer.subarray(0, newlineIndex).toString("utf8");
        state.buffer = state.buffer.subarray(newlineIndex + 1);
        if (line.trim().length > 0) {
          const frame = parseClientFrame(line);
          if (!frame) {
            log("received malformed frame");
            socket.destroy();
            closeConnection(state, "malformed frame");
            return;
          }
          handleFrame(state, frame);
          if (state.closed) return;
        }
        newlineIndex = state.buffer.indexOf(0x0a);
      }
    });

    socket.on("error", (error) => {
      if (!state.closed) log(`socket error: ${error.message}`);
      closeConnection(state, "socket error");
    });
    socket.on("close", () => {
      closeConnection(state, "remote closed");
    });
  }

  function health(): HostHealth {
    return {
      ok: true,
      pid: process.pid,
      uptimeMs: Date.now() - startedAt,
      protocolVersion: PROTOCOL_VERSION,
      connections,
      handshaked,
      requests,
      processes: listManagedProcesses().length,
      sessions: 0,
    };
  }

  async function close(): Promise<void> {
    if (closing) return closing;
    closing = (async () => {
      listenersDetached = true;
      offProcessesChange();
      offTerminalChange();
      clearBroadcastTimers();
      for (const state of [...sockets]) {
        try {
          state.socket.destroy();
        } catch {
          // Already gone.
        }
        closeConnection(state, "host shutdown");
      }
      subscriptions.clear();

      // Cascade cleanup: every shell wrapper/dev server spawned by this host
      // is killed as a process tree before the host exits.
      try {
        const stopped = await stopAllManagedProcesses();
        if (stopped > 0) log(`stopped ${stopped} managed process(es)`);
      } catch (error) {
        log(`failed to stop managed processes: ${error instanceof Error ? error.message : String(error)}`);
      }

      await new Promise<void>((resolve) => {
        if (!server) {
          cleanupEndpoint();
          resolve();
          return;
        }
        server.close(() => {
          cleanupEndpoint();
          resolve();
        });
      });
    })();
    return closing;
  }

  function cleanupEndpoint(): void {
    if (process.platform === "win32") return;
    try {
      if (existsSync(options.endpoint)) unlinkSync(options.endpoint);
    } catch {
      // A stale socket file is harmless; the next start removes it.
    }
  }

  async function start(): Promise<void> {
    prepareEndpoint(options.endpoint);
    server = createServer(handleConnection);
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server?.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server?.off("error", onError);
        resolve();
      };
      server!.once("error", onError);
      server!.once("listening", onListening);
      server!.listen(options.endpoint);
    });

    server.on("error", (error) => {
      log(`server error: ${error.message}`);
      options.onFatal?.(error);
    });

    options.onReady?.(options.endpoint);
  }

  return {
    endpoint: options.endpoint,
    start,
    close,
    health,
  };
}

