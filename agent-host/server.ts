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
import { buildApiRequest, dispatchApiRequest } from "./api-router.ts";
import { hostPhase } from "./host-phases.ts";
import { getAgentDir } from "./sdk-adapter.ts";
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
import { ensureRecommendedPiSettings } from "./settings-defaults.ts";
import { isCodemodeMode } from "../lib/desktop-settings.ts";
import {
  subscribeSessionStream,
  type SessionSubscription,
  type StreamEvent,
} from "./session-events.ts";
import { deleteSession, renameSession } from "./session-admin.ts";
import { cloneSessionToWorktree, GitWorktreeError } from "./workspace-clone.ts";
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
  forceStopManagedProcess,
  hasFailedProcessCleanup,
  removeManagedProcessEntry,
  restartManagedProcess,
  sendManagedProcessInput,
  startManagedProcess,
  stopAllManagedProcesses,
  stopManagedProcess,
} from "./managed-processes.ts";
import {
  ensureProcessInstanceState,
  getProcessInstanceId,
  shutdownProcessInstanceState,
} from "./process-instance-store.ts";
import { reapOrphanedProcesses } from "./crash-reaper.ts";
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
import {
  listSubagents,
  onSubagentsChange,
  stopAllSubagents,
  stopSubagent,
} from "./subagents.ts";
import type { SubagentLifecycleEvent } from "../contract/domains/subagents.ts";
import {
  listHerdrAgents,
  onHerdrChange,
  sendHerdrMessage,
  stopAllHerdrAgents,
  stopHerdrAgent,
  wakeFleetAgent,
} from "./herdr-manager.ts";
import {
  deleteFleetProfile,
  getFleetProfile,
  importFleetProfiles,
  listFleetProfiles,
  saveFleetProfile,
} from "./fleet-store.ts";
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
import {
  CustomProviderError,
  listCustomProviders,
  removeCustomProvider,
  saveCustomProvider,
  syncCustomProvidersToModels,
} from "./custom-providers.ts";
import { createHostWebSocketServer, type HostWebSocketServer } from "./ws-server.ts";
import {
  initPlugins,
  listPlugins,
  PluginManagerError,
  setPluginEnabled,
  stopPlugins,
} from "./plugin-manager.ts";
import {
  acceptIntervention,
  getTaskStatus,
  getWatchdogSnapshot,
  setWatchdogStallMs,
  stopWatchdogTimer,
} from "./watchdog.ts";
import { isInterventionAction, shouldInterruptTool } from "./intervention.ts";

import {
  listOrchestratorTasks,
  onOrchestratorChange,
  OrchestratorError,
  spawnOrchestratorTask,
  stopAllOrchestratorTasks,
  stopOrchestratorTask,
} from "./orchestrator.ts";

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

const GLOBAL_TOPICS: readonly GlobalTopic[] = ["processes", "terminal", "subagents", "fleet"];

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
  /**
   * 流式 `/api/**` 响应（SSE）的句柄：streamId → 取消函数 + 所属连接。
   * 连接断开时一并取消，避免 renderer 关窗后 Host 还在往死管道里泵数据。
   */
  const apiStreams = new Map<string, { close: () => void; state: ConnectionState }>();
  const agentSubscriptions = new Map<string, AgentSubscription>();
  const broadcastTimers = new Map<GlobalTopic, NodeJS.Timeout>();
  const lastBroadcastAt = new Map<GlobalTopic, number>();
  let server: Server | null = null;
  let closing: Promise<void> | null = null;
  let connections = 0;
  let handshaked = 0;
  let requests = 0;
  let listenersDetached = false;
  const wsServer: HostWebSocketServer = createHostWebSocketServer({
    token: options.token,
    log,
    onCall: async (request) => {
      // Privileged operations requested by plugins go through this narrow
      // Host RPC surface. A plugin never gets fs/child_process itself.
      switch (request.method) {
        case "host.health":
          return health();
        case "host.transport":
          return wsServer.info();
        case "plugins.list":
          return { plugins: listPlugins() };
        case "orchestrator.list":
          return { tasks: listOrchestratorTasks() };
        case "files.authorize": {
          const target = request.params.path;
          const mode = request.params.mode;
          if (typeof target !== "string" || (mode !== "read" && mode !== "write")) {
            throw new Error("files.authorize requires path and mode=read|write");
          }
          return { path: await authorizePath(target, mode) };
        }
        case "processes.start": {
          const cwd = request.params.cwd;
          const command = request.params.command;
          if (typeof cwd !== "string" || typeof command !== "string") {
            throw new Error("processes.start requires cwd and command");
          }
          return { process: startManagedProcess({ cwd, command, owner: "agent" }) };
        }
        case "mcp.probe":
          return probeMcpServer(request.params as never);
        default:
          throw new Error(`Unsupported WebSocket method: ${request.method}`);
      }
    },
  });

  const offProcessesChange = onManagedProcessesChange(() => scheduleBroadcast("processes"));
  const offTerminalChange = onTerminalLogChange(() => scheduleBroadcast("terminal"));
  let lastSubagentEvent: SubagentLifecycleEvent | undefined;
  let pendingSubagentEvents: SubagentLifecycleEvent[] = [];
  const offOrchestratorChange = onOrchestratorChange((task) => {
    wsServer.publish("orchestrator.changed", { task });
  });
  // 常驻舰队的实时状态：面板靠这条主题同步（herdr 不再靠 2s 轮询）。
  const offHerdrChange = onHerdrChange(() => scheduleBroadcast("fleet"));
  const offSubagentsChange = onSubagentsChange((event) => {
    if (event) {
      lastSubagentEvent = event;
      pendingSubagentEvents.push(event);
      if (pendingSubagentEvents.length > 100) pendingSubagentEvents.shift();
    }
    scheduleBroadcast("subagents");
  });

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

  function failCustomProvider(state: ConnectionState, id: number, error: unknown): void {
    if (error instanceof CustomProviderError) {
      fail(state, id, error.code === "E_INVALID_PARAMS" ? "E_INVALID_PARAMS" : "INTERNAL", error.message);
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
    if (topic === "subagents") {
      const payload: HostEventPayloads["subagents.changed"] = {
        agents: listSubagents(),
        ...(lastSubagentEvent ? { event: lastSubagentEvent } : {}),
        ...(pendingSubagentEvents.length > 0 ? { events: [...pendingSubagentEvents] } : {}),
      };
      pendingSubagentEvents = [];
      for (const subscription of targets) sendEvent(subscription, topic, payload);
      return;
    }
    if (topic === "fleet") {
      const payload: HostEventPayloads["fleet.changed"] = { agents: listHerdrAgents() };
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
    for (const [streamId, stream] of apiStreams) {
      if (stream.state === state) {
        stream.close();
        apiStreams.delete(streamId);
      }
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
    if (topic === "subagents") {
      sendEvent(subscription, topic, {
        agents: listSubagents(),
        ...(lastSubagentEvent ? { event: lastSubagentEvent } : {}),
      });
      return;
    }
    if (topic === "fleet") {
      sendEvent(subscription, topic, { agents: listHerdrAgents() });
      return;
    }
    sendEvent(subscription, topic, { blocks: listTerminalBlocks() });
  }

  /**
   * 跑一条外壳层 `/api/**` 请求（P1-4）。
   *
   * 普通响应整体读进内存（JSON/图片，最大 32MB 上传、10MB 预览）；
   * `text/event-stream` 走流式：先回 `res` 给出 `streamId`，随后用
   * `api.stream.chunk` / `api.stream.end` 事件推（客户端按 subscriptionId 归位）。
   */
  async function handleApiRequest(
    state: ConnectionState,
    id: number,
    params: Record<string, unknown>,
  ): Promise<void> {
    const method = readString(params, "method");
    const url = readString(params, "url");
    if (!method || !url) {
      fail(state, id, "E_INVALID_PARAMS", "method and url are required");
      return;
    }

    const rawHeaders = isRecord(params.headers) ? params.headers : undefined;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawHeaders ?? {})) {
      if (typeof value === "string") headers[key] = value;
    }

    const bodyBase64 = typeof params.bodyBase64 === "string" ? params.bodyBase64 : null;
    const body =
      bodyBase64 !== null ? Buffer.from(bodyBase64, "base64") : method === "GET" || method === "HEAD" ? undefined : null;

    const startedAt = Date.now();
    let response: Response;
    try {
      response = await dispatchApiRequest(buildApiRequest({ method, url, headers, body }));
      if (process.env.PIFORGE_DEBUG_API === "1") {
        const cost = Date.now() - startedAt;
        if (cost >= 5) log(`[api] ${method} ${new URL(url).pathname} ${cost}ms`);
      }
    } catch (error) {
      fail(state, id, "INTERNAL", error instanceof Error ? error.message : String(error));
      return;
    }

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    const streaming = response.body !== null && (responseHeaders["content-type"] ?? "").includes("text/event-stream");
    if (!streaming) {
      const buffer = response.body ? Buffer.from(await response.arrayBuffer()) : Buffer.alloc(0);
      result(state, id, {
        status: response.status,
        headers: responseHeaders,
        bodyBase64: buffer.toString("base64"),
        // `PIFORGE_HEAP_PROBE=1`：把 Host 当前 heap 一起回报，
        // 供 scripts/audit-route-heap.mjs 归档"每条路由首载把多少字节变成常驻"。
        ...(process.env.PIFORGE_HEAP_PROBE === "1"
          ? {
              // 先强制 GC 再读：这样 heapUsed 是"被保留下来的常驻字节"，
              // 不含本次请求的临时分配（否则每条路由都 +几 MB 假增量）。
              // 需要宿主以 `node --expose-gc` 启动（audit-route-heap.mjs 会这么起）。
              hostHeapUsed: (() => {
                // @types/node 已声明 `gc?: GCFunction`（--expose-gc 才存在）。
                const gc = globalThis.gc;
                if (typeof gc === "function") {
                  try {
                    gc();
                  } catch {
                    // 忽略：没有 --expose-gc 时退化为普通读取
                  }
                }
                return process.memoryUsage().heapUsed;
              })(),
            }
          : {}),
      });
      return;
    }

    const streamId = `api-stream-${randomUUID()}`;
    const reader = response.body!.getReader();
    let seq = 0;
    apiStreams.set(streamId, {
      state,
      close: () => {
        void reader.cancel().catch(() => {});
      },
    });

    // 先回 res：客户端拿到 streamId 后才能把后续块归位。
    result(state, id, { status: response.status, headers: responseHeaders, streamId });

    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.length === 0) continue;
          seq += 1;
          const ok = writeFrame(state, {
            kind: "evt",
            subscriptionId: streamId,
            seq,
            topic: "api.stream.chunk",
            payload: { chunkBase64: Buffer.from(value).toString("base64") },
          });
          if (!ok) break;
        }
      } catch {
        // 上游流中断（Host 关停 / 路由抛错）：结束帧仍然要发，让客户端释句柄。
      } finally {
        seq += 1;
        writeFrame(state, {
          kind: "evt",
          subscriptionId: streamId,
          seq,
          topic: "api.stream.end",
          payload: {},
        });
        apiStreams.delete(streamId);
      }
    })();
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
      case "host.transport": {
        result(state, frame.id, wsServer.info());
        return;
      }
      case "plugins.list": {
        result(state, frame.id, { plugins: listPlugins(), transport: wsServer.info() });
        return;
      }
      case "plugins.setEnabled": {
        const id = readString(params, "id");
        if (!id || typeof params.enabled !== "boolean") {
          fail(state, frame.id, "E_INVALID_PARAMS", "id and enabled are required");
          return;
        }
        void setPluginEnabled(id, params.enabled)
          .then((plugin) => {
            requestSessionResourceReload();
            wsServer.publish("plugins.changed", { plugin });
            result(state, frame.id, { plugin });
          })
          .catch((error: unknown) => {
            fail(state, frame.id, error instanceof PluginManagerError ? "E_INVALID_PARAMS" : "INTERNAL", errorText(error));
          });
        return;
      }
      case "orchestrator.spawn": {
        const input = params as unknown as Parameters<typeof spawnOrchestratorTask>[0];
        void spawnOrchestratorTask(input)
          .then((task) => {
            requestSessionResourceReload();
            result(state, frame.id, { task });
          })
          .catch((error: unknown) => {
            const message = errorText(error);
            if (error instanceof OrchestratorError && error.code === "E_LIMIT") {
              fail(state, frame.id, "E_BACKPRESSURE", message);
            } else {
              fail(state, frame.id, "INTERNAL", message);
            }
          });
        return;
      }
      case "orchestrator.list": {
        result(state, frame.id, { tasks: listOrchestratorTasks() });
        return;
      }
      case "orchestrator.stop": {
        const id = readString(params, "id");
        if (!id) {
          fail(state, frame.id, "E_INVALID_PARAMS", "id is required");
          return;
        }
        void stopOrchestratorTask(id).then((ok) => result(state, frame.id, { ok }));
        return;
      }
      case "plugins.reload": {
        void initPlugins({
          wsUrl: wsServer.info().wsUrl,
          token: options.token,
        })
          .then((plugins) => {
            requestSessionResourceReload();
            wsServer.publish("plugins.changed", { plugins });
            result(state, frame.id, { plugins });
          })
          .catch((error: unknown) => fail(state, frame.id, "INTERNAL", errorText(error)));
        return;
      }
      case "models.providers.list": {
        try {
          result(state, frame.id, { providers: listCustomProviders() });
        } catch (error) {
          failCustomProvider(state, frame.id, error);
        }
        return;
      }
      case "models.providers.save": {
        try {
          const input = params as unknown as Parameters<typeof saveCustomProvider>[0];
          const provider = saveCustomProvider(input);
          invalidateAuxRuntime();
          requestSessionResourceReload();
          wsServer.publish("models.providers.changed", { provider });
          result(state, frame.id, { provider });
        } catch (error) {
          failCustomProvider(state, frame.id, error);
        }
        return;
      }
      case "models.providers.remove": {
        const id = readString(params, "id");
        if (!id) {
          fail(state, frame.id, "E_INVALID_PARAMS", "id is required");
          return;
        }
        try {
          removeCustomProvider(id);
          invalidateAuxRuntime();
          requestSessionResourceReload();
          wsServer.publish("models.providers.changed", { removed: id });
          result(state, frame.id, { ok: true });
        } catch (error) {
          failCustomProvider(state, frame.id, error);
        }
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
        const owner = params.owner;
        if (owner !== undefined && owner !== "agent" && owner !== "user") {
          fail(state, frame.id, "E_INVALID_PARAMS", "owner must be 'agent' or 'user'");
          return;
        }
        const name = readOptionalString(params, "name");
        try {
          const process = startManagedProcess({
            cwd,
            command,
            ...(name ? { name } : {}),
            ...(owner ? { owner } : {}),
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
      case "processes.forceStop": {
        const id = readString(params, "id");
        if (!id) {
          fail(state, frame.id, "E_INVALID_PARAMS", "id is required");
          return;
        }
        respond(state, frame.id, forceStopManagedProcess(id), (ok) => ({ ok }));
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
      case "agent.intervene": {
        // 人工介入（HITL）：注入一条指令到既有队列，并立刻重置看门狗告警。
        // 全程复用 steer / prompt / follow-up 队列，没有任何新增的模型直连。
        const sessionId = readString(params, "sessionId");
        if (!sessionId) {
          fail(state, frame.id, "E_INVALID_PARAMS", "sessionId is required");
          return;
        }
        const actionType = params.actionType;
        if (!isInterventionAction(actionType)) {
          fail(state, frame.id, "E_INVALID_PARAMS", "actionType must be 'skip' | 'ask' | 'ask_brief'");
          return;
        }
        const session = getRpcSession(sessionId);
        if (!session?.isAlive()) {
          fail(state, frame.id, "SESSION_NOT_FOUND", "Session not running");
          return;
        }
        // 只做「同步受理 + 立刻回执」：守卫 / 拼文案 / 重置看门狗都是纯逻辑，
        // 投递本身可能等到当前工具跑完才落地，UI 不该陪着等（否则按钮会「转很久」）。
        const accepted = acceptIntervention({ sessionId, actionType });
        if (accepted.ok && shouldInterruptTool(actionType, accepted.task?.tools)) {
          // 「强制跳过」+ 工具已跑过阈值才真打断；短命令打断只会白丢结果。
          try {
            session.abortCurrentTool?.();
          } catch {
            /* 打断失败不影响后面的投递 */
          }
        }
        result(state, frame.id, accepted);
        if (accepted.ok) {
          void session.deliverIntervention(accepted.message).catch((error: unknown) => {
            console.error("intervention delivery failed:", errorText(error));
          });
        }
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
        const mode = params.mode;
        if (mode !== undefined && !isCodemodeMode(mode)) {
          fail(state, frame.id, "E_INVALID_PARAMS", "mode must be on | only");
          return;
        }
        updateSessionCodemode(params.enabled, mode);
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
      case "watchdog.status": {
        // 只读快照：纯程序层观测结果，不进 prompt、不触发任何模型调用。
        result(state, frame.id, getWatchdogSnapshot());
        return;
      }
      case "watchdog.configure": {
        // 运行期调阈值：只写内存配置，不触发任何模型调用，也不重建定时器。
        const stallMs = params.stallMs;
        if (typeof stallMs !== "number" || !Number.isFinite(stallMs) || stallMs <= 0) {
          fail(state, frame.id, "E_INVALID_PARAMS", "stallMs must be a positive number");
          return;
        }
        result(state, frame.id, setWatchdogStallMs(stallMs));
        return;
      }
      case "watchdog.task": {
        const taskId = readString(params, "taskId");
        if (!taskId) {
          fail(state, frame.id, "E_INVALID_PARAMS", "taskId is required");
          return;
        }
        result(state, frame.id, { task: getTaskStatus(taskId) });
        return;
      }
      case "subagents.list": {
        result(state, frame.id, { agents: listSubagents() });
        return;
      }
      // ---- 外壳层 HTTP 路由（P1-4：拆掉 Next server 后唯一的数据通道）----
      case "api.request": {
        void handleApiRequest(state, frame.id, params);
        return;
      }
      case "api.stream.close": {
        const streamId = readString(params, "streamId");
        if (!streamId) {
          fail(state, frame.id, "E_INVALID_PARAMS", "streamId is required");
          return;
        }
        apiStreams.get(streamId)?.close();
        apiStreams.delete(streamId);
        result(state, frame.id, { ok: true });
        return;
      }
      case "subagents.stop": {
        const id = readString(params, "id");
        if (!id) {
          fail(state, frame.id, "E_INVALID_PARAMS", "id is required");
          return;
        }
        result(state, frame.id, { ok: stopSubagent(id) });
        return;
      }
      case "herdr.list": {
        result(state, frame.id, { agents: listHerdrAgents() });
        return;
      }
      /**
       * 常驻舰队配置。配置存在 `<agentDir>/fleet/agents.json`，
       * 重启后 `fleet.list` 原样回显；唤醒才会真正建会话（且不烧首轮 token）。
       */
      case "fleet.list": {
        result(state, frame.id, {
          profiles: listFleetProfiles(getAgentDir()),
          agents: listHerdrAgents(),
        });
        return;
      }
      case "fleet.save": {
        try {
          const profile = saveFleetProfile(getAgentDir(), params.profile);
          result(state, frame.id, { profile });
        } catch (error) {
          fail(state, frame.id, "E_INVALID_PARAMS", errorText(error));
        }
        return;
      }
      case "fleet.delete": {
        result(state, frame.id, { ok: deleteFleetProfile(getAgentDir(), readString(params, "id") ?? "") });
        return;
      }
      case "fleet.import": {
        try {
          const profiles = importFleetProfiles(getAgentDir(), params.payload);
          result(state, frame.id, { profiles });
        } catch (error) {
          fail(state, frame.id, "E_INVALID_PARAMS", errorText(error));
        }
        return;
      }
      case "fleet.wake": {
        const id = readString(params, "id");
        const profile = id ? getFleetProfile(getAgentDir(), id) : null;
        if (!profile) {
          fail(state, frame.id, "E_INVALID_PARAMS", `No fleet profile with id "${id ?? ""}"`);
          return;
        }
        try {
          const agent = wakeFleetAgent({
            name: profile.name,
            cwd: readString(params, "cwd") ?? process.cwd(),
            parentSessionId: readString(params, "parentSessionId") ?? "desktop",
            systemPrompt: profile.systemPrompt,
            tools: profile.tools,
          });
          result(state, frame.id, { agent });
        } catch (error) {
          fail(state, frame.id, "INTERNAL", errorText(error));
        }
        return;
      }
      case "fleet.message": {
        const id = readString(params, "id");
        const message = readString(params, "message");
        if (!id || !message) {
          fail(state, frame.id, "E_INVALID_PARAMS", "id and message are required");
          return;
        }
        void sendHerdrMessage(id, message)
          .then((outcome) =>
            result(state, frame.id, {
              ok: outcome.ok,
              agent: outcome.agent,
              text: outcome.text,
            }),
          )
          .catch((error: unknown) => fail(state, frame.id, "INTERNAL", errorText(error)));
        return;
      }
      case "herdr.stop": {
        const id = readString(params, "id");
        if (!id) {
          fail(state, frame.id, "E_INVALID_PARAMS", "id is required");
          return;
        }
        void stopHerdrAgent(id)
          .then((ok) => result(state, frame.id, { ok }))
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
      // Host-owned Git worktree clone
      // ---------------------------------------------------------------------
      case "workspace.cloneSession": {
        const sessionId = readString(params, "sessionId");
        const sessionFile = readString(params, "sessionFile");
        const sourceCwd = readString(params, "sourceCwd");
        const targetCwd = readString(params, "targetCwd");
        if (!sessionId || !sessionFile || !sourceCwd || !targetCwd) {
          fail(state, frame.id, "E_INVALID_PARAMS", "sessionId, sessionFile, sourceCwd and targetCwd are required");
          return;
        }
        const branchName = readOptionalString(params, "branchName");
        const name = readOptionalString(params, "name");
        void cloneSessionToWorktree({
          sessionId,
          sessionFile,
          sourceCwd,
          targetCwd,
          ...(branchName ? { branchName } : {}),
          ...(name ? { name } : {}),
        })
          .then((cloned) => result(state, frame.id, cloned))
          .catch((error: unknown) => {
            if (error instanceof GitWorktreeError) {
              fail(state, frame.id, error.code, error.message);
              return;
            }
            if (error instanceof AccessDeniedError) {
              fail(state, frame.id, "ACCESS_DENIED", error.message);
              return;
            }
            fail(state, frame.id, "INTERNAL", errorText(error));
          });
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
          ...(params.summarize === true ? { summarize: true } : {}),
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
      offHerdrChange();
      offProcessesChange();
      offTerminalChange();
      offSubagentsChange();
      // 看门狗只读常驻：关 Host 的时候顺手停掉扫描定时器（不写任何文件）。
      stopWatchdogTimer();
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

      try {
        await stopAllOrchestratorTasks();
      } catch (error) {
        log(`failed to stop orchestrator workers: ${errorText(error)}`);
      }
      offOrchestratorChange();
      try {
        stopPlugins();
      } catch (error) {
        log(`failed to stop plugins: ${errorText(error)}`);
      }
      try {
        await wsServer.close();
      } catch (error) {
        log(`failed to close websocket bus: ${errorText(error)}`);
      }

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
        await stopAllSubagents();
      } catch (error) {
        log(`failed to stop sub-agents: ${errorText(error)}`);
      }
      try {
        await stopAllHerdrAgents();
      } catch (error) {
        log(`failed to stop fleet agents: ${errorText(error)}`);
      }

      try {
        const stopped = await stopAllManagedProcesses();
        if (stopped > 0) log(`stopped ${stopped} managed process(es)`);
      } catch (error) {
        log(`failed to stop managed processes: ${error instanceof Error ? error.message : String(error)}`);
      }
      // Clean shutdown: remove this host's process-state file so the next
      // start has nothing to reap.
      shutdownProcessInstanceState({ keepForReaper: hasFailedProcessCleanup() });

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
    try {
      syncCustomProvidersToModels();
    } catch (error) {
      log(`custom provider sync failed: ${errorText(error)}`);
    }
    // 一次性补写推荐 pi 设置（只在键缺失时写，绝不覆盖用户手改值）。
    try {
      const applied = ensureRecommendedPiSettings(getAgentDir());
      if (applied.written.length > 0) {
        log(`pi settings defaults applied: ${applied.written.join(", ")}`);
      }
    } catch (error) {
      log(`pi settings defaults failed: ${errorText(error)}`);
    }
    prepareEndpoint(options.endpoint);
    hostPhase("config.sync");
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

    hostPhase("pipe.listen");
    server.on("error", (error) => {
      log(`server error: ${error.message}`);
      options.onFatal?.(error);
    });

    // Crash recovery: register this host instance, then reap process trees
    // left by a previous host that is no longer heartbeating. Runs async so a
    // slow identity check (PowerShell/ps) never delays readiness.
    ensureProcessInstanceState();
    void reapOrphanedProcesses({ ownInstanceId: getProcessInstanceId(), log })
      .then((report) => {
        if (report.reaped.length > 0) {
          log(`crash reaper: terminated ${report.reaped.length} orphaned process tree(s)`);
        }
        if (report.failed.length > 0) {
          log(`crash reaper: ${report.failed.length} record(s) left running (fail-closed)`);
        }
      })
      .catch((error: unknown) => log(`crash reaper failed: ${errorText(error)}`));

    try {
      await wsServer.start();
    } catch (error) {
      log(`websocket bus failed to start: ${errorText(error)}`);
      throw error;
    }
    hostPhase("ws.bus");

    try {
      await initPlugins({
        wsUrl: wsServer.info().wsUrl,
        token: options.token,
        log,
      });
    } catch (error) {
      log(`plugin manager failed to initialize: ${errorText(error)}`);
    }
    hostPhase("plugins.init");

    options.onReady?.(options.endpoint);

    /**
     * 预热"进程内 API 客户端"（路由 → Host 的环回管道）。
     *
     * 实测：`files.authorize` 的**首**调用要 418 ms（建连 + 握手 + 读 allowed-roots），
     * 之后的调用只要 1 ms。而渲染进程第一批请求（files.list / git.status / sessions）
     * 几乎同时到达，撞上冷启动会一起排队 —— 实测这一段把 Host 的 CPU 顶到 64%，
     * 10 s 平均下来就是 8–10%。
     *
     * 放在 onReady **之后**、fire-and-forget：不拖慢 `host_ready`，但等渲染进程
     * 开始请求时连接已经热了。
     */
    void (async () => {
      try {
        const { getAgentHostClient } = await import("../lib/agent-host-client.ts");
        const client = getAgentHostClient();
        await client.call("host.health", {}, { timeoutMs: 5_000 });
        // 顺手把文件授权链路的 allowed-roots 也读一遍（同一次冷启动的成本）。
        await client.call("files.allowedRoots", {}).catch(() => {});
        log("api client prewarmed");
      } catch (error) {
        log(`api client prewarm failed: ${errorText(error)}`);
      }
    })();
  }

  return {
    endpoint: options.endpoint,
    start,
    close,
    health,
  };
}

