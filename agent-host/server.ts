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
import type { McpConnectionConfig } from "../contract/domains/mcp.ts";
import type { DecisionQuestion } from "../contract/domains/aux-models.ts";
import { validateAgentCommand } from "../lib/agent-commands.ts";
import { isAgentMode, isToolPreset } from "../lib/approval-policy.ts";
import {
  applyTrustDecision,
  evaluateProjectTrust,
  isTrustOptionId,
} from "../lib/project-trust-desktop.ts";
import {
  destroyAllRpcSessions,
  getRpcSession,
  listRpcSessions,
  requestSessionResourceReload,
  startRpcSession,
  updateSessionCodemode,
} from "./rpc-manager.ts";
import {
  subscribeSessionStream,
  type SessionSubscription,
  type StreamEvent,
} from "./session-events.ts";
import { deleteSession, renameSession } from "./session-admin.ts";
import { getSessionOnlyTrustMap } from "./trust-store.ts";
import {
  AccessDeniedError,
  addAllowedRoot,
  authorizePath,
  getAllowedRoots,
} from "./allowed-roots.ts";
import {
  pushBrowserSnapshot,
  recordBrowserPoll,
  resolveBrowserCommand,
  takeBrowserCommands,
  type BrowserCommandResult,
  type BrowserPageSnapshot,
} from "./browser-bridge.ts";
import { getMemoryService } from "./ltm/service.ts";
import { isBusyError } from "./ltm/sqlite-backend.ts";
import {
  isLtmDisabledError,
  isStatsNotSupportedError,
  parseForgetBody,
  parseLimit,
  parseRememberBody,
} from "./ltm/http.ts";
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
  clearAllBrowserSessionGrants,
  forgetSessionBrowserPermissions,
} from "./browser-permissions.ts";
import {
  clearTerminalLog,
  finishShellBlock,
  listTerminalBlocks,
  onTerminalLogChange,
  setShellOutput,
  startShellBlock,
} from "./terminal-log.ts";
import {
  cancelMcpLogin,
  closeAllMcpClients,
  getLoginStatus,
  isMcpAuthRequiredError,
  listMcpResources,
  loginMcpServer,
  logoutMcpServer,
  McpServiceError,
  mcpAuthStatus,
  probeMcpServer,
  readMcpResource,
  refreshMcpAuth,
} from "./mcp-service.ts";
import { probeDevEnvironment } from "./dev-tools.ts";
import { applyCodeToFile, FileApplyError } from "./file-apply.ts";
import {
  getSessionBranches,
  SessionBranchError,
  switchSessionBranch,
} from "./session-branches.ts";
import { clearPendingSessionLeaves, forgetPendingSessionLeaf } from "./session-branch-state.ts";
import {
  HISTORY_DEFAULT_LIMIT,
  HISTORY_MAX_LIMIT,
  isToolOutputPath,
  readToolOutputPage,
} from "./tool-outputs.ts";
import {
  AuxModelError,
  classifyDecision,
  generateImage,
  getAuxCatalogue,
  invalidateAuxRuntime,
  readAuxConfig,
  setAuxConfig,
} from "./aux-models.ts";

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

interface AgentSubscription {
  id: string;
  sessionId: string;
  connection: ConnectionState;
  stream: SessionSubscription;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  const agentSubscriptions = new Map<string, AgentSubscription>();
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

  function removeAgentSubscription(subscriptionId: string): void {
    const subscription = agentSubscriptions.get(subscriptionId);
    if (!subscription) return;
    subscription.stream.unsubscribe();
    agentSubscriptions.delete(subscriptionId);
  }

  function sendAgentEvent(
    subscription: AgentSubscription,
    event: StreamEvent,
    seq: number,
  ): void {
    if (agentSubscriptions.get(subscription.id) !== subscription) return;
    const ok = writeFrame(subscription.connection, {
      kind: "evt",
      subscriptionId: subscription.id,
      seq,
      topic: "agent.event",
      payload: { sessionId: subscription.sessionId, event },
    });
    if (!ok) removeAgentSubscription(subscription.id);
  }

  function failLtm(
    state: ConnectionState,
    id: number,
    error: unknown,
    statsNotSupported = false,
  ): void {
    if (isLtmDisabledError(error)) {
      fail(state, id, "LTM_DISABLED", "Long-term memory is disabled");
      return;
    }
    if (isBusyError(error)) {
      fail(state, id, "LTM_BUSY", "Long-term memory is busy");
      return;
    }
    if (statsNotSupported && isStatsNotSupportedError(error)) {
      fail(state, id, "INTERNAL", "Memory stats are not supported by this backend");
      return;
    }
    fail(state, id, "INTERNAL", errorText(error));
  }

  function failMcp(state: ConnectionState, id: number, error: unknown): void {
    if (error instanceof McpServiceError) {
      fail(state, id, error.code, error.message);
      return;
    }
    if (isMcpAuthRequiredError(error)) {
      fail(state, id, "MCP_AUTH_REQUIRED", errorText(error));
      return;
    }
    fail(state, id, "INTERNAL", errorText(error));
  }

  function failBranch(state: ConnectionState, id: number, error: unknown): void {
    if (error instanceof SessionBranchError) {
      fail(state, id, error.code, error.message);
      return;
    }
    fail(state, id, "INTERNAL", errorText(error));
  }

  function failAux(state: ConnectionState, id: number, error: unknown): void {
    if (error instanceof AuxModelError) {
      fail(state, id, error.code, error.message);
      return;
    }
    fail(state, id, "AUX_MODEL_FAILED", errorText(error));
  }

  /** `undefined` = not provided, `null` = clear, otherwise a validated selection. */
  function readAuxSelection(
    params: Record<string, unknown>,
    key: string,
  ): { provider: string; modelId: string } | null | undefined {
    const value = params[key];
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value !== "object" || Array.isArray(value)) {
      throw new AuxModelError("E_INVALID_PARAMS", `${key} must be an object or null`);
    }
    const record = value as Record<string, unknown>;
    if (typeof record.provider !== "string" || !record.provider.trim()) {
      throw new AuxModelError("E_INVALID_PARAMS", `${key}.provider must be a non-empty string`);
    }
    if (typeof record.modelId !== "string" || !record.modelId.trim()) {
      throw new AuxModelError("E_INVALID_PARAMS", `${key}.modelId must be a non-empty string`);
    }
    return { provider: record.provider, modelId: record.modelId };
  }

  function readMcpRef(params: Record<string, unknown>): { cwd?: string; serverId: string; scope?: "global" | "project" } | null {
    const serverId = readString(params, "serverId");
    if (!serverId) return null;
    const scope = params.scope;
    if (scope !== undefined && scope !== "global" && scope !== "project") return null;
    const cwd = readOptionalString(params, "cwd");
    return {
      serverId,
      ...(cwd ? { cwd } : {}),
      ...(scope ? { scope } : {}),
    };
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
    for (const [id, subscription] of agentSubscriptions) {
      if (subscription.connection === state) removeAgentSubscription(id);
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
        const closedSessions = listRpcSessions().length;
        result(state, frame.id, { closedSessions, stoppedProcesses });
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

      // ---------------------------------------------------------------------
      // Agent sessions
      // ---------------------------------------------------------------------
      case "agent.create": {
        const cwd = readString(params, "cwd");
        if (!cwd) {
          fail(state, frame.id, "E_INVALID_PARAMS", "cwd is required");
          return;
        }
        addAllowedRoot(cwd);
        const command = params.command;
        if (!isRecord(command)) {
          fail(state, frame.id, "E_INVALID_PARAMS", "command must be an object");
          return;
        }
        const commandError = validateAgentCommand(command);
        if (commandError) {
          fail(state, frame.id, "E_INVALID_PARAMS", commandError);
          return;
        }
        const agentMode = isAgentMode(params.agentMode) ? params.agentMode : undefined;
        const toolPreset = isToolPreset(params.toolPreset) ? params.toolPreset : undefined;
        const toolNames = Array.isArray(params.toolNames) && params.toolNames.every((name) => typeof name === "string")
          ? (params.toolNames as string[])
          : undefined;
        const provider = typeof params.provider === "string" ? params.provider : undefined;
        const modelId = typeof params.modelId === "string" ? params.modelId : undefined;
        const thinkingLevel = typeof params.thinkingLevel === "string" ? params.thinkingLevel : undefined;
        const tempKey = `__new__${Date.now()}__${Math.random().toString(36).slice(2, 8)}`;

        void (async () => {
          const { session, realSessionId } = await startRpcSession(tempKey, "", cwd, {
            toolNames,
            agentMode,
            toolPreset,
          });
          if (provider && modelId) {
            await session.send({ type: "set_model", provider, modelId });
          }
          if (thinkingLevel) {
            await session.send({ type: "set_thinking_level", level: thinkingLevel });
          }
          // Fire-and-forget: a run may open an extension dialog, and the
          // renderer only learns the session id from this response.
          void session.send(command).catch((error: unknown) => {
            session.reportError(errorText(error));
          });
          result(state, frame.id, { sessionId: realSessionId });
        })().catch((error: unknown) => {
          fail(state, frame.id, "AGENT_START_FAILED", errorText(error));
        });
        return;
      }
      case "agent.ensure": {
        const sessionId = readString(params, "sessionId");
        const filePath = readString(params, "filePath");
        const cwd = readString(params, "cwd");
        if (!sessionId || !filePath || !cwd) {
          fail(state, frame.id, "E_INVALID_PARAMS", "sessionId, filePath and cwd are required");
          return;
        }
        addAllowedRoot(cwd);
        const agentMode = isAgentMode(params.agentMode) ? params.agentMode : undefined;
        const toolPreset = isToolPreset(params.toolPreset) ? params.toolPreset : undefined;
        const toolNames = Array.isArray(params.toolNames) && params.toolNames.every((name) => typeof name === "string")
          ? (params.toolNames as string[])
          : undefined;
        void startRpcSession(sessionId, filePath, cwd, { toolNames, agentMode, toolPreset })
          .then(({ session, realSessionId }) => {
            result(state, frame.id, { sessionId: realSessionId, live: session.isAlive() });
          })
          .catch((error: unknown) => {
            fail(state, frame.id, "AGENT_START_FAILED", errorText(error));
          });
        return;
      }
      case "agent.command": {
        const sessionId = readString(params, "sessionId");
        if (!sessionId) {
          fail(state, frame.id, "E_INVALID_PARAMS", "sessionId is required");
          return;
        }
        const command = params.command;
        if (!isRecord(command)) {
          fail(state, frame.id, "E_INVALID_PARAMS", "command must be an object");
          return;
        }
        const commandError = validateAgentCommand(command);
        if (commandError) {
          fail(state, frame.id, "E_INVALID_PARAMS", commandError);
          return;
        }
        const session = getRpcSession(sessionId);
        if (!session?.isAlive()) {
          fail(state, frame.id, "SESSION_NOT_FOUND", "Session not running");
          return;
        }
        respond(state, frame.id, session.send(command), (data) => ({ data }));
        return;
      }
      case "agent.state": {
        const sessionId = readString(params, "sessionId");
        if (!sessionId) {
          fail(state, frame.id, "E_INVALID_PARAMS", "sessionId is required");
          return;
        }
        const session = getRpcSession(sessionId);
        if (!session?.isAlive()) {
          result(state, frame.id, { running: false });
          return;
        }
        if (params.peek === true) {
          result(state, frame.id, { running: true, state: session.peekState() });
          return;
        }
        respond(state, frame.id, session.send({ type: "get_state" }), (data) => ({
          running: true,
          state: data,
        }));
        return;
      }
      case "agent.keepAlive": {
        const sessionId = readString(params, "sessionId");
        if (!sessionId) {
          fail(state, frame.id, "E_INVALID_PARAMS", "sessionId is required");
          return;
        }
        getRpcSession(sessionId)?.keepAlive();
        result(state, frame.id, { ok: true });
        return;
      }
      case "agent.destroy": {
        const sessionId = readString(params, "sessionId");
        if (!sessionId) {
          fail(state, frame.id, "E_INVALID_PARAMS", "sessionId is required");
          return;
        }
        void (getRpcSession(sessionId)?.destroy() ?? Promise.resolve())
          .then(() => {
            forgetSessionBrowserPermissions(sessionId);
            result(state, frame.id, { ok: true });
          })
          .catch((error: unknown) => fail(state, frame.id, "INTERNAL", errorText(error)));
        return;
      }
      case "agent.subscribe": {
        const sessionId = readString(params, "sessionId");
        if (!sessionId) {
          fail(state, frame.id, "E_INVALID_PARAMS", "sessionId is required");
          return;
        }
        const fromSeq = params.fromSeq;
        if (fromSeq !== undefined && (typeof fromSeq !== "number" || !Number.isFinite(fromSeq) || fromSeq < 0)) {
          fail(state, frame.id, "E_INVALID_PARAMS", "fromSeq must be a non-negative number");
          return;
        }
        const session = getRpcSession(sessionId);
        if (!session?.isAlive()) {
          fail(state, frame.id, "SESSION_NOT_FOUND", "Session not running");
          return;
        }
        const subscriptionId = randomUUID();
        let subscription: AgentSubscription | null = null;
        const stream = subscribeSessionStream(
          sessionId,
          typeof fromSeq === "number" ? fromSeq : undefined,
          (event, seq) => {
            if (subscription) sendAgentEvent(subscription, event, seq);
          },
        );
        if (!stream) {
          fail(state, frame.id, "SESSION_NOT_FOUND", "Session event stream not attached");
          return;
        }
        subscription = { id: subscriptionId, sessionId, connection: state, stream };
        agentSubscriptions.set(subscriptionId, subscription);
        result(state, frame.id, {
          subscriptionId,
          lastSeq: stream.lastSeq,
          running: Boolean(session.inner.isStreaming),
        });
        if (agentSubscriptions.has(subscriptionId)) stream.activate();
        return;
      }
      case "agent.unsubscribe": {
        const subscriptionId = readString(params, "subscriptionId");
        if (!subscriptionId) {
          fail(state, frame.id, "E_INVALID_PARAMS", "subscriptionId is required");
          return;
        }
        removeAgentSubscription(subscriptionId);
        result(state, frame.id, { ok: true });
        return;
      }
      case "agent.reloadResources": {
        const cwd = readOptionalString(params, "cwd");
        requestSessionResourceReload(cwd);
        result(state, frame.id, { reloaded: listRpcSessions().length });
        return;
      }
      case "agent.updateCodemode": {
        if (typeof params.enabled !== "boolean") {
          fail(state, frame.id, "E_INVALID_PARAMS", "enabled must be a boolean");
          return;
        }
        updateSessionCodemode(params.enabled);
        result(state, frame.id, { updated: listRpcSessions().length });
        return;
      }

      // ---------------------------------------------------------------------
      // MCP management: all connections and OAuth stay in this process.
      // ---------------------------------------------------------------------
      case "mcp.probe": {
        const serverId = readOptionalString(params, "serverId");
        const connection = params.connection;
        if (serverId !== undefined && (typeof serverId !== "string" || !serverId.trim())) {
          fail(state, frame.id, "E_INVALID_PARAMS", "serverId must be a non-empty string");
          return;
        }
        if (!serverId && (!connection || typeof connection !== "object" || Array.isArray(connection))) {
          fail(state, frame.id, "E_INVALID_PARAMS", "serverId or connection is required");
          return;
        }
        const scope = params.scope;
        if (scope !== undefined && scope !== "global" && scope !== "project") {
          fail(state, frame.id, "E_INVALID_PARAMS", "scope must be 'global' or 'project'");
          return;
        }
        void probeMcpServer({
          ...(readOptionalString(params, "cwd") ? { cwd: readOptionalString(params, "cwd") } : {}),
          ...(serverId ? { serverId, scope } : {}),
          ...(connection ? { connection: connection as McpConnectionConfig } : {}),
        })
          .then((report) => result(state, frame.id, report))
          .catch((error: unknown) => failMcp(state, frame.id, error));
        return;
      }
      case "mcp.resources": {
        const ref = readMcpRef(params);
        if (!ref) {
          fail(state, frame.id, "E_INVALID_PARAMS", "serverId is required");
          return;
        }
        void listMcpResources(ref)
          .then((resources) => result(state, frame.id, resources))
          .catch((error: unknown) => failMcp(state, frame.id, error));
        return;
      }
      case "mcp.readResource": {
        const ref = readMcpRef(params);
        const uri = readString(params, "uri");
        if (!ref || !uri) {
          fail(state, frame.id, "E_INVALID_PARAMS", "serverId and uri are required");
          return;
        }
        void readMcpResource({ ...ref, uri })
          .then((resource) => result(state, frame.id, resource))
          .catch((error: unknown) => failMcp(state, frame.id, error));
        return;
      }
      case "mcp.authStatus": {
        const ref = readMcpRef(params);
        if (!ref) {
          fail(state, frame.id, "E_INVALID_PARAMS", "serverId is required");
          return;
        }
        void Promise.resolve()
          .then(() => mcpAuthStatus(ref))
          .then((auth) => result(state, frame.id, auth))
          .catch((error: unknown) => failMcp(state, frame.id, error));
        return;
      }
      case "mcp.login": {
        const ref = readMcpRef(params);
        if (!ref) {
          fail(state, frame.id, "E_INVALID_PARAMS", "serverId is required");
          return;
        }
        void loginMcpServer(ref)
          .then((login) => result(state, frame.id, login))
          .catch((error: unknown) => failMcp(state, frame.id, error));
        return;
      }
      case "mcp.cancelLogin": {
        const loginId = readString(params, "loginId");
        if (!loginId) {
          fail(state, frame.id, "E_INVALID_PARAMS", "loginId is required");
          return;
        }
        void cancelMcpLogin(loginId)
          .then((ok) => result(state, frame.id, { ok }))
          .catch((error: unknown) => failMcp(state, frame.id, error));
        return;
      }
      case "mcp.loginStatus": {
        const loginId = readString(params, "loginId");
        if (!loginId) {
          fail(state, frame.id, "E_INVALID_PARAMS", "loginId is required");
          return;
        }
        result(state, frame.id, { login: getLoginStatus(loginId) });
        return;
      }
      case "mcp.logout": {
        const ref = readMcpRef(params);
        if (!ref) {
          fail(state, frame.id, "E_INVALID_PARAMS", "serverId is required");
          return;
        }
        void logoutMcpServer(ref)
          .then((ok) => result(state, frame.id, { ok }))
          .catch((error: unknown) => failMcp(state, frame.id, error));
        return;
      }
      case "mcp.refreshAuth": {
        const ref = readMcpRef(params);
        if (!ref) {
          fail(state, frame.id, "E_INVALID_PARAMS", "serverId is required");
          return;
        }
        void refreshMcpAuth(ref)
          .then((auth) => result(state, frame.id, auth))
          .catch((error: unknown) => failMcp(state, frame.id, error));
        return;
      }

      // ---------------------------------------------------------------------
      // Auxiliary models: image generation and structured decisions.
      // ---------------------------------------------------------------------
      case "models.auxCatalogue": {
        void getAuxCatalogue()
          .then((catalogue) => result(state, frame.id, catalogue))
          .catch((error: unknown) => failAux(state, frame.id, error));
        return;
      }
      case "models.auxConfig": {
        void Promise.resolve()
          .then(() => readAuxConfig())
          .then((config) => result(state, frame.id, config))
          .catch((error: unknown) => failAux(state, frame.id, error));
        return;
      }
      case "models.setAuxConfig": {
        let image: { provider: string; modelId: string } | null | undefined;
        let decision: { provider: string; modelId: string } | null | undefined;
        try {
          image = readAuxSelection(params, "image");
          decision = readAuxSelection(params, "decision");
        } catch (error) {
          failAux(state, frame.id, error);
          return;
        }
        if (image === undefined && decision === undefined) {
          fail(state, frame.id, "E_INVALID_PARAMS", "image or decision is required");
          return;
        }
        void setAuxConfig({ image, decision })
          .then((config) => {
            // Running sessions pick the new tools up on their next prompt.
            requestSessionResourceReload();
            result(state, frame.id, config);
          })
          .catch((error: unknown) => failAux(state, frame.id, error));
        return;
      }
      case "image.generate": {
        const prompt = readString(params, "prompt");
        if (!prompt) {
          fail(state, frame.id, "E_INVALID_PARAMS", "prompt is required");
          return;
        }
        let model: { provider: string; modelId: string } | null | undefined;
        try {
          model = readAuxSelection(params, "model");
        } catch (error) {
          failAux(state, frame.id, error);
          return;
        }
        void generateImage(prompt, model)
          .then((report) => result(state, frame.id, report))
          .catch((error: unknown) => failAux(state, frame.id, error));
        return;
      }
      case "toolOutput.read": {
        const file = readString(params, "file");
        if (!file) {
          fail(state, frame.id, "E_INVALID_PARAMS", "file is required");
          return;
        }
        if (!isToolOutputPath(file)) {
          fail(state, frame.id, "ACCESS_DENIED", "Not a persisted tool output path");
          return;
        }
        const offset = params.offset;
        const limit = params.limit;
        if (offset !== undefined && (typeof offset !== "number" || !Number.isFinite(offset) || offset < 0)) {
          fail(state, frame.id, "E_INVALID_PARAMS", "offset must be a non-negative number");
          return;
        }
        if (
          limit !== undefined &&
          (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1 || limit > HISTORY_MAX_LIMIT)
        ) {
          fail(state, frame.id, "E_INVALID_PARAMS", `limit must be between 1 and ${HISTORY_MAX_LIMIT}`);
          return;
        }
        void readToolOutputPage(
          file,
          offset === undefined ? 0 : Math.floor(offset),
          limit === undefined ? HISTORY_DEFAULT_LIMIT : Math.floor(limit),
        )
          .then((page) => result(state, frame.id, page))
          .catch((error: unknown) => fail(state, frame.id, "INTERNAL", errorText(error)));
        return;
      }
      case "env.probe": {
        if (params.refresh !== undefined && typeof params.refresh !== "boolean") {
          fail(state, frame.id, "E_INVALID_PARAMS", "refresh must be a boolean");
          return;
        }
        void probeDevEnvironment({ refresh: params.refresh === true })
          .then((report) => result(state, frame.id, report))
          .catch((error: unknown) => fail(state, frame.id, "INTERNAL", errorText(error)));
        return;
      }
      case "decision.classify": {
        const state0 = params.state;
        if (!state0 || typeof state0 !== "object" || Array.isArray(state0)) {
          fail(state, frame.id, "E_INVALID_PARAMS", "state must be an object");
          return;
        }
        const questions = params.questions;
        if (!Array.isArray(questions) || questions.length === 0) {
          fail(state, frame.id, "E_INVALID_PARAMS", "questions must be a non-empty array");
          return;
        }
        let model: { provider: string; modelId: string } | null | undefined;
        try {
          model = readAuxSelection(params, "model");
        } catch (error) {
          failAux(state, frame.id, error);
          return;
        }
        void classifyDecision({
          state: state0 as Record<string, unknown>,
          questions: questions as DecisionQuestion[],
          model,
        })
          .then((report) => result(state, frame.id, report))
          .catch((error: unknown) => failAux(state, frame.id, error));
        return;
      }

      // ---------------------------------------------------------------------
      // Session branches
      // ---------------------------------------------------------------------
      case "sessions.getBranches": {
        const sessionId = readString(params, "sessionId");
        if (!sessionId) {
          fail(state, frame.id, "E_INVALID_PARAMS", "sessionId is required");
          return;
        }
        const filePath = readOptionalString(params, "filePath");
        void getSessionBranches({ sessionId, ...(filePath ? { filePath } : {}) })
          .then((branches) => result(state, frame.id, branches))
          .catch((error: unknown) => failBranch(state, frame.id, error));
        return;
      }
      case "sessions.switchBranch": {
        const sessionId = readString(params, "sessionId");
        if (!sessionId) {
          fail(state, frame.id, "E_INVALID_PARAMS", "sessionId is required");
          return;
        }
        const leafId = params.leafId;
        if (leafId !== null && typeof leafId !== "string") {
          fail(state, frame.id, "E_INVALID_PARAMS", "leafId must be a string or null");
          return;
        }
        const filePath = readOptionalString(params, "filePath");
        void switchSessionBranch({
          sessionId,
          leafId,
          ...(filePath ? { filePath } : {}),
        })
          .then((switched) => result(state, frame.id, switched))
          .catch((error: unknown) => failBranch(state, frame.id, error));
        return;
      }

      // ---------------------------------------------------------------------
      // Session metadata / mutation
      // ---------------------------------------------------------------------
      case "sessions.locate": {
        const sessionId = readString(params, "sessionId");
        if (!sessionId) {
          fail(state, frame.id, "E_INVALID_PARAMS", "sessionId is required");
          return;
        }
        const session = getRpcSession(sessionId);
        if (!session?.isAlive()) {
          result(state, frame.id, { filePath: null, live: false });
          return;
        }
        result(state, frame.id, { filePath: session.inner.sessionFile ?? "", live: true });
        return;
      }
      case "sessions.state": {
        const sessionId = readString(params, "sessionId");
        if (!sessionId) {
          fail(state, frame.id, "E_INVALID_PARAMS", "sessionId is required");
          return;
        }
        const session = getRpcSession(sessionId);
        if (!session?.isAlive()) {
          result(state, frame.id, { running: false });
          return;
        }
        let liveHeader: { id: string; cwd: string; timestamp: string } | undefined;
        try {
          const header = session.inner.sessionManager.getHeader();
          if (header) {
            liveHeader = {
              id: sessionId,
              cwd: header.cwd ?? "",
              timestamp: header.timestamp ?? new Date().toISOString(),
            };
          }
        } catch {
          // Header is best effort.
        }
        result(state, frame.id, {
          running: true,
          state: session.peekState(),
          ...(liveHeader ? { liveHeader } : {}),
        });
        return;
      }
      case "sessions.rename": {
        const sessionId = readString(params, "sessionId");
        const filePath = readString(params, "filePath");
        if (!sessionId || !filePath || typeof params.name !== "string") {
          fail(state, frame.id, "E_INVALID_PARAMS", "sessionId, filePath and name are required");
          return;
        }
        void renameSession(sessionId, filePath, params.name)
          .then(() => result(state, frame.id, { ok: true }))
          .catch((error: unknown) => fail(state, frame.id, "INTERNAL", errorText(error)));
        return;
      }
      case "sessions.delete": {
        const sessionId = readString(params, "sessionId");
        const filePath = readString(params, "filePath");
        if (!sessionId || !filePath) {
          fail(state, frame.id, "E_INVALID_PARAMS", "sessionId and filePath are required");
          return;
        }
        void deleteSession(sessionId, filePath)
          .then(() => {
            forgetPendingSessionLeaf(sessionId);
            result(state, frame.id, { ok: true });
          })
          .catch((error: unknown) => fail(state, frame.id, "INTERNAL", errorText(error)));
        return;
      }

      // ---------------------------------------------------------------------
      // File access policy (Next performs the IO on the returned path)
      // ---------------------------------------------------------------------
      case "files.allowedRoots": {
        void getAllowedRoots()
          .then((roots) => result(state, frame.id, { roots: [...roots] }))
          .catch((error: unknown) => fail(state, frame.id, "INTERNAL", errorText(error)));
        return;
      }
      case "files.applyCode": {
        const filePath = readString(params, "path");
        const content = typeof params.content === "string" ? params.content : null;
        const mode = params.mode;
        if (!filePath || content === null || (mode !== "overwrite" && mode !== "append")) {
          fail(state, frame.id, "E_INVALID_PARAMS", "path, content and mode ('overwrite'|'append') are required");
          return;
        }
        void applyCodeToFile({ path: filePath, content, mode })
          .then((applied) => result(state, frame.id, applied))
          .catch((error: unknown) => {
            if (error instanceof AccessDeniedError) {
              fail(state, frame.id, "ACCESS_DENIED", error.message);
              return;
            }
            if (error instanceof FileApplyError) {
              fail(state, frame.id, error.code, error.message);
              return;
            }
            fail(state, frame.id, "INTERNAL", errorText(error));
          });
        return;
      }
      case "files.authorize": {
        const target = readString(params, "path");
        const op = params.op;
        if (!target || (op !== "read" && op !== "write" && op !== "list")) {
          fail(state, frame.id, "E_INVALID_PARAMS", "path and op (read|write|list) are required");
          return;
        }
        void authorizePath(target, op)
          .then((realPath) => result(state, frame.id, { realPath }))
          .catch((error: unknown) => {
            if (error instanceof AccessDeniedError) {
              fail(state, frame.id, "ACCESS_DENIED", error.message);
              return;
            }
            fail(state, frame.id, "INTERNAL", errorText(error));
          });
        return;
      }

      // ---------------------------------------------------------------------
      // Browser bridge
      // ---------------------------------------------------------------------
      case "browser.poll": {
        recordBrowserPoll();
        result(state, frame.id, { connected: true, commands: takeBrowserCommands() });
        return;
      }
      case "browser.pushSnapshot": {
        if (!isRecord(params.snapshot)) {
          fail(state, frame.id, "E_INVALID_PARAMS", "snapshot is required");
          return;
        }
        pushBrowserSnapshot(params.snapshot as Partial<BrowserPageSnapshot>);
        result(state, frame.id, { ok: true });
        return;
      }
      case "browser.resolveCommand": {
        if (!isRecord(params.result) || typeof params.result.id !== "string") {
          fail(state, frame.id, "E_INVALID_PARAMS", "result.id is required");
          return;
        }
        resolveBrowserCommand(params.result as unknown as BrowserCommandResult);
        result(state, frame.id, { ok: true });
        return;
      }

      // ---------------------------------------------------------------------
      // Trust
      // ---------------------------------------------------------------------
      case "trust.evaluate": {
        const cwd = readString(params, "cwd");
        if (!cwd) {
          fail(state, frame.id, "E_INVALID_PARAMS", "cwd is required");
          return;
        }
        result(
          state,
          frame.id,
          evaluateProjectTrust(cwd, {
            sessionOnlyTrust: getSessionOnlyTrustMap(),
            forceTrusted: params.forceTrusted === true,
          }),
        );
        return;
      }
      case "trust.apply": {
        const cwd = readString(params, "cwd");
        if (!cwd || !isTrustOptionId(params.optionId)) {
          fail(state, frame.id, "E_INVALID_PARAMS", "cwd and a valid optionId are required");
          return;
        }
        const applied = applyTrustDecision(cwd, params.optionId, {
          sessionOnlyTrust: getSessionOnlyTrustMap(),
        });
        result(state, frame.id, { success: true, ...applied });
        return;
      }

      // ---------------------------------------------------------------------
      // Long-term memory
      // ---------------------------------------------------------------------
      case "memory.health": {
        void (async () => {
          const service = getMemoryService();
          const health = await service.health();
          result(state, frame.id, { ...health, enabled: service.isEnabled() });
        })().catch((error: unknown) => failLtm(state, frame.id, error));
        return;
      }
      case "memory.recall": {
        const cwd = readString(params, "cwd");
        const query = readString(params, "q");
        if (!cwd || !query) {
          fail(state, frame.id, "E_INVALID_PARAMS", "cwd and q are required");
          return;
        }
        const service = getMemoryService();
        if (!service.isEnabled()) {
          fail(state, frame.id, "LTM_DISABLED", "Long-term memory is disabled");
          return;
        }
        const limit = parseLimit(params.limit);
        void service.recallFromCwd(cwd, { query, limit })
          .then((hits) => result(state, frame.id, { hits }))
          .catch((error: unknown) => failLtm(state, frame.id, error));
        return;
      }
      case "memory.remember": {
        const parsed = parseRememberBody(params);
        if (!parsed.ok) {
          fail(state, frame.id, "E_INVALID_PARAMS", parsed.error);
          return;
        }
        const service = getMemoryService();
        if (!service.isEnabled()) {
          fail(state, frame.id, "LTM_DISABLED", "Long-term memory is disabled");
          return;
        }
        const { cwd, ...input } = parsed.value;
        void service.rememberFromCwd(cwd, input)
          .then((remembered) => result(state, frame.id, remembered))
          .catch((error: unknown) => failLtm(state, frame.id, error));
        return;
      }
      case "memory.forget": {
        const parsed = parseForgetBody(params);
        if (!parsed.ok) {
          fail(state, frame.id, "E_INVALID_PARAMS", parsed.error);
          return;
        }
        const service = getMemoryService();
        if (!service.isEnabled()) {
          fail(state, frame.id, "LTM_DISABLED", "Long-term memory is disabled");
          return;
        }
        const { cwd, ...input } = parsed.value;
        void service.forgetFromCwd(cwd, input)
          .then((forgotten) => result(state, frame.id, forgotten))
          .catch((error: unknown) => failLtm(state, frame.id, error));
        return;
      }
      case "memory.stats": {
        const cwd = readString(params, "cwd");
        if (!cwd) {
          fail(state, frame.id, "E_INVALID_PARAMS", "cwd is required");
          return;
        }
        const service = getMemoryService();
        if (!service.isEnabled()) {
          fail(state, frame.id, "LTM_DISABLED", "Long-term memory is disabled");
          return;
        }
        void service.statsFromCwd(cwd)
          .then((stats) => result(state, frame.id, stats))
          .catch((error: unknown) => failLtm(state, frame.id, error, true));
        return;
      }

      case "models.refresh": {
        // Credentials or models.json changed: drop cached auxiliary runtime
        // state so image/decision calls resolve fresh auth.
        invalidateAuxRuntime();
        requestSessionResourceReload();
        result(state, frame.id, { sessions: listRpcSessions().length });
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
      sessions: listRpcSessions().length,
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

      for (const subscriptionId of [...agentSubscriptions.keys()]) {
        removeAgentSubscription(subscriptionId);
      }

      // Drain agent sessions first so their final .jsonl writes are flushed,
      // then kill the managed process trees.
      try {
        const closed = await destroyAllRpcSessions();
        if (closed > 0) log(`closed ${closed} agent session(s)`);
      } catch (error) {
        log(`failed to close agent sessions: ${errorText(error)}`);
      }

      // Cascade cleanup: every shell wrapper/dev server spawned by this host
      // is killed as a process tree before the host exits.
      try {
        await closeAllMcpClients();
      } catch (error) {
        log(`failed to close MCP management connections: ${errorText(error)}`);
      }
      clearAllBrowserSessionGrants();
      clearPendingSessionLeaves();

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

