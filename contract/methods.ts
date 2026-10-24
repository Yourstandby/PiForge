/**
 * Method map for the Agent Host contract.
 *
 * Naming: `<domain>.<verb>`, lower-case, dot separated. Parameters and
 * results are always objects so additive fields stay backwards compatible.
 */
import type {
  AgentCommandDto,
  AgentLiveState,
  AgentModeDto,
  SessionLiveHeader,
  ToolPresetDto,
} from "./domains/agent.ts";
import type {
  BrowserCommand,
  BrowserCommandResult,
  BrowserPageSnapshot,
} from "./domains/browser.ts";
import type { DevEnvironmentReport } from "./domains/dev-environment.ts";
import type { SessionBranches, SessionBranchSwitchResult } from "./domains/sessions.ts";
import type { SubagentView } from "./domains/subagents.ts";
import type { FleetAgentProfile } from "./domains/fleet.ts";
import type { ToolOutputPageDto } from "./domains/tool-outputs.ts";
import type {
  AuxModelCatalogue,
  AuxModelConfig,
  AuxModelSelection,
  DecisionQuestion,
  DecisionReport,
  ImageGenerationReport,
} from "./domains/aux-models.ts";
import type {
  McpAuthState,
  McpConnectionConfig,
  McpConnectionReport,
  McpPendingLogin,
  McpResourceReadResult,
  McpScope,
  McpServerRef,
} from "./domains/mcp.ts";
import type {
  MemoryHealth,
  MemoryStats,
  MemoryType,
  RecallHit,
} from "./domains/memory.ts";
import type { ManagedProcessView } from "./domains/processes.ts";
import type { HerdrAgentView } from "./domains/herdr.ts";
import type {
  OrchestratorSpawnInput,
  OrchestratorTaskView,
} from "./domains/orchestrator.ts";
import type { PluginView } from "./domains/plugins.ts";
import type {
  CustomProviderInput,
  CustomProviderView,
  HostTransportInfo,
} from "./domains/providers.ts";
import type { TerminalBlock, TerminalBlockStatus } from "./domains/terminal.ts";
import type {
  InterventionActionType,
  InterventionResult,
  WatchdogConfigView,
  WatchdogSnapshot,
  WatchdogTaskView,
} from "./domains/watchdog.ts";
import type {
  NeedsTrustPayload,
  TrustOptionId,
} from "./domains/trust.ts";
import type { GlobalTopic } from "./events.ts";

export interface HostHealth {
  ok: boolean;
  pid: number;
  uptimeMs: number;
  protocolVersion: number;
  /** Connections accepted since host start. */
  connections: number;
  /** Connections that completed the handshake. */
  handshaked: number;
  /** Requests handled since host start. */
  requests: number;
  /** Managed background processes currently tracked (running or exited). */
  processes: number;
  /** Live agent sessions. */
  sessions: number;
}

export type TrustGateResult =
  | { action: "proceed"; trusted: boolean }
  | { action: "prompt"; payload: NeedsTrustPayload };

/** 舰队配置的输入草稿（保存 / 导入都接受不完整字段，服务端会校验）。 */
export interface FleetProfileInput {
  id?: string;
  name: string;
  systemPrompt: string;
  tools?: string[];
  persistent?: boolean;
}

export interface AgentHostMethods {
  "host.health": {
    params: Record<string, never>;
    result: HostHealth;
  };
  "host.shutdown": {
    params: { drainMs?: number };
    result: { closedSessions: number; stoppedProcesses: number };
  };
  "host.subscribe": {
    params: { topics: GlobalTopic[] };
    result: { subscriptionId: string };
  };
  "host.unsubscribe": {
    params: { subscriptionId: string };
    result: { ok: true };
  };
  "host.transport": {
    params: Record<string, never>;
    result: HostTransportInfo;
  };

  // ---- model-agnostic custom providers ----
  "models.providers.list": {
    params: Record<string, never>;
    result: { providers: CustomProviderView[] };
  };
  "models.providers.save": {
    params: CustomProviderInput;
    result: { provider: CustomProviderView };
  };
  "models.providers.remove": {
    params: { id: string };
    result: { ok: true };
  };

  // ---- sandboxed plugins ----
  "plugins.list": {
    params: Record<string, never>;
    result: { plugins: PluginView[]; transport: HostTransportInfo };
  };
  "plugins.setEnabled": {
    params: { id: string; enabled: boolean };
    result: { plugin: PluginView };
  };
  "plugins.reload": {
    params: Record<string, never>;
    result: { plugins: PluginView[] };
  };

  // ---- process-isolated orchestration workers ----
  "orchestrator.spawn": {
    params: OrchestratorSpawnInput;
    result: { task: OrchestratorTaskView };
  };
  "orchestrator.list": {
    params: Record<string, never>;
    result: { tasks: OrchestratorTaskView[] };
  };
  "orchestrator.stop": {
    params: { id: string };
    result: { ok: boolean };
  };

  // ---- managed background processes ----
  "processes.list": {
    params: Record<string, never>;
    result: { processes: ManagedProcessView[] };
  };
  "processes.start": {
    params: {
      cwd: string;
      command: string;
      name?: string;
      /** Who started it; crash-reaper only touches "agent" processes. */
      owner?: "agent" | "user";
    };
    result: { process: ManagedProcessView };
  };
  "processes.stop": {
    params: { id: string };
    result: { ok: boolean };
  };
  "processes.forceStop": {
    params: { id: string };
    result: { ok: boolean };
  };
  "processes.restart": {
    params: { id: string };
    result: { process: ManagedProcessView | null };
  };
  "processes.remove": {
    params: { id: string };
    result: { ok: boolean };
  };
  "processes.stdin": {
    params: { id: string; input: string };
    result: { ok: boolean };
  };

  // ---- shell-output terminal log ----
  "terminal.list": {
    params: Record<string, never>;
    result: { blocks: TerminalBlock[] };
  };
  "terminal.clear": {
    params: Record<string, never>;
    result: { ok: true };
  };
  "terminal.shellStart": {
    params: { id: string; command: string; cwd?: string | null };
    result: { ok: true };
  };
  "terminal.shellUpdate": {
    params: { id: string; text: string };
    result: { ok: true };
  };
  "terminal.shellFinish": {
    params: { id: string; text?: string; status?: TerminalBlockStatus };
    result: { ok: boolean };
  };

  // ---- agent sessions ----
  "agent.create": {
    params: {
      cwd: string;
      command: AgentCommandDto;
      provider?: string;
      modelId?: string;
      thinkingLevel?: string;
      toolNames?: string[];
      agentMode?: AgentModeDto;
      toolPreset?: ToolPresetDto;
    };
    result: { sessionId: string };
  };
  "agent.ensure": {
    params: {
      sessionId: string;
      filePath: string;
      cwd: string;
      toolNames?: string[];
      agentMode?: AgentModeDto;
      toolPreset?: ToolPresetDto;
    };
    result: { sessionId: string; live: boolean };
  };
  "agent.command": {
    params: { sessionId: string; command: AgentCommandDto };
    result: { data: unknown };
  };
  "agent.state": {
    params: { sessionId: string; peek?: boolean };
    result: { running: boolean; state?: AgentLiveState };
  };
  "agent.keepAlive": {
    params: { sessionId: string };
    result: { ok: true };
  };
  "agent.destroy": {
    params: { sessionId: string };
    result: { ok: true };
  };
  "agent.subscribe": {
    params: { sessionId: string; fromSeq?: number };
    result: { subscriptionId: string; lastSeq: number; running: boolean };
  };
  "agent.unsubscribe": {
    params: { subscriptionId: string };
    result: { ok: true };
  };
  "agent.reloadResources": {
    params: { cwd?: string };
    result: { reloaded: number };
  };
  "agent.updateCodemode": {
    params: { enabled: boolean };
    result: { updated: number };
  };

  // ---- MCP management (connections and OAuth live only in the host) ----
  "mcp.probe": {
    params: {
      cwd?: string;
      serverId?: string;
      scope?: McpScope;
      connection?: McpConnectionConfig;
    };
    result: McpConnectionReport;
  };
  "mcp.resources": {
    params: McpServerRef;
    result: {
      toolsCount: number;
      resources: McpConnectionReport["resources"];
      resourceTemplates: McpConnectionReport["resourceTemplates"];
    };
  };
  "mcp.readResource": {
    params: McpServerRef & { uri: string };
    result: McpResourceReadResult;
  };
  "mcp.authStatus": {
    params: McpServerRef;
    result: McpAuthState;
  };
  "mcp.login": {
    params: McpServerRef;
    result: { loginId: string; authorizationUrl: string };
  };
  "mcp.cancelLogin": {
    params: { loginId: string };
    result: { ok: boolean };
  };
  "mcp.logout": {
    params: McpServerRef;
    result: { ok: boolean };
  };
  "mcp.refreshAuth": {
    params: McpServerRef;
    result: McpAuthState;
  };
  "mcp.loginStatus": {
    params: { loginId: string };
    result: { login: McpPendingLogin | null };
  };

  // ---- auxiliary models (image generation / structured decisions) ----
  "models.auxCatalogue": {
    params: Record<string, never>;
    result: AuxModelCatalogue;
  };
  "models.auxConfig": {
    params: Record<string, never>;
    result: AuxModelConfig;
  };
  "models.setAuxConfig": {
    params: {
      image?: AuxModelSelection | null;
      decision?: AuxModelSelection | null;
    };
    result: AuxModelConfig;
  };
  "image.generate": {
    params: { prompt: string; model?: AuxModelSelection };
    result: ImageGenerationReport;
  };
  "decision.classify": {
    params: {
      state: Record<string, unknown>;
      questions: DecisionQuestion[];
      model?: AuxModelSelection;
    };
    result: DecisionReport;
  };

  // ---- sub-agents ----
  "subagents.list": {
    params: Record<string, never>;
    result: { agents: SubagentView[] };
  };
  "subagents.stop": {
    params: { id: string };
    result: { ok: boolean };
  };

  // ---- 无进展看门狗（只读，纯程序层观测，绝不参与模型调用）----
  "watchdog.status": {
    params: Record<string, never>;
    result: WatchdogSnapshot;
  };
  /**
   * 运行期调整停滞阈值（UI 下拉框 15/30/60/90 秒）。
   * 只改 Host 内存配置，返回最新配置视图；不重建定时器、不碰模型。
   */
  "watchdog.configure": {
    params: { stallMs: number };
    result: WatchdogConfigView;
  };
  /** 单个任务的只读查询：`get_task_status(task_id)`。 */
  "watchdog.task": {
    params: { taskId: string };
    result: { task: WatchdogTaskView | null };
  };

  // ---- 外壳层的 HTTP 路由（P1-4：拆掉 Next server 之后唯一的传输层）----
  /**
   * 把一条 `/api/...` 请求交给 Host 内已加载的路由（`app/api/**\/route.ts`）。
   *
   * 返回两种形态：
   *   - `bodyBase64`：普通响应，已整体读好；
   *   - `streamId`：流式响应（SSE），后续内容以 `api.stream` 事件推过来。
   * 走到这里的原因：桌面端没有 HTTP 监听（零内部端口），renderer 的
   * `fetch("/api/…")` 由 Electron `protocol.handle` 接住再转发到这里。
   */
  "api.request": {
    params: {
      method: string;
      url: string;
      headers?: Record<string, string>;
      bodyBase64?: string | null;
    };
    result: {
      status: number;
      headers: Record<string, string>;
      bodyBase64?: string;
      streamId?: string;
    };
  };
  /** 关闭一条流式响应（renderer 取消订阅 / 窗口关闭）。幂等。 */
  "api.stream.close": {
    params: { streamId: string };
    result: { ok: boolean };
  };
  /**
   * 人工介入：向该会话的待处理队列注入一条指令，并立刻重置看门狗告警。
   * 复用既有 steer / prompt / follow-up 队列，不新增任何模型直连。
   */
  "agent.intervene": {
    params: { sessionId: string; actionType: InterventionActionType };
    result: InterventionResult;
  };

  // ---- development environment probes ----
  "env.probe": {
    params: { refresh?: boolean };
    result: DevEnvironmentReport;
  };

  // ---- persisted large tool outputs (files owned by the host) ----
  "toolOutput.read": {
    params: { file: string; offset?: number; limit?: number };
    result: ToolOutputPageDto;
  };

  // ---- session branches (tree already exists in the JSONL) ----
  // ---- Herdr agent fleet ----
  "herdr.list": {
    params: Record<string, never>;
    result: { agents: HerdrAgentView[] };
  };
  "herdr.stop": {
    params: { id: string };
    result: { ok: boolean };
  };

  // ---- fleet agent profiles (persistent, manually managed) ----
  "fleet.list": {
    params: Record<string, never>;
    result: { profiles: FleetAgentProfile[]; agents: HerdrAgentView[] };
  };
  "fleet.save": {
    params: { profile: FleetProfileInput };
    result: { profile: FleetAgentProfile };
  };
  "fleet.delete": {
    params: { id: string };
    result: { ok: boolean };
  };
  "fleet.import": {
    params: { payload: unknown };
    result: { profiles: FleetAgentProfile[] };
  };
  "fleet.wake": {
    params: { id: string; cwd?: string; parentSessionId?: string };
    result: { agent: HerdrAgentView };
  };
  "fleet.message": {
    params: { id: string; message: string };
    result: { ok: boolean; agent: HerdrAgentView; text: string };
  };

  // ---- Host-owned workspace / Git worktree clone ----
  "workspace.cloneSession": {
    params: {
      sessionId: string;
      sessionFile: string;
      sourceCwd: string;
      targetCwd: string;
      branchName?: string;
      name?: string;
    };
    result: {
      success: true;
      sessionId: string;
      sessionFile: string;
      workspace: { mode: "worktree"; cwd: string; branchName: string };
      worktree: {
        repoRoot: string;
        gitDir: string;
        head: string;
        branchOwnerToken: string;
        ownerMarkerPath?: string;
        ownerToken?: string;
      };
    };
  };

  "sessions.getBranches": {
    params: { sessionId: string; filePath?: string };
    result: SessionBranches;
  };
  "sessions.switchBranch": {
    params: { sessionId: string; filePath?: string; leafId: string | null };
    result: SessionBranchSwitchResult;
  };

  // ---- session metadata / mutation ----
  "sessions.locate": {
    params: { sessionId: string };
    result: { filePath: string | null; live: boolean };
  };
  "sessions.state": {
    params: { sessionId: string };
    result: {
      running: boolean;
      state?: AgentLiveState;
      liveHeader?: SessionLiveHeader;
    };
  };
  "sessions.rename": {
    params: { sessionId: string; filePath: string; name: string };
    result: { ok: true };
  };
  "sessions.delete": {
    params: { sessionId: string; filePath: string };
    result: { ok: true };
  };

  // ---- files (authorization lives in the host; bytes stay in Next) ----
  "files.allowedRoots": {
    params: Record<string, never>;
    result: { roots: string[] };
  };
  "files.authorize": {
    params: { path: string; op: "read" | "write" | "list" };
    result: { realPath: string };
  };
  "files.applyCode": {
    params: { path: string; content: string; mode: "overwrite" | "append" };
    result: { path: string; mode: "overwrite" | "append"; bytes: number };
  };

  // ---- browser bridge ----
  "browser.poll": {
    params: Record<string, never>;
    result: { connected: boolean; commands: BrowserCommand[] };
  };
  "browser.pushSnapshot": {
    params: { snapshot: Partial<BrowserPageSnapshot> };
    result: { ok: true };
  };
  "browser.resolveCommand": {
    params: { result: BrowserCommandResult };
    result: { ok: true };
  };

  // ---- trust ----
  "trust.evaluate": {
    params: { cwd: string; forceTrusted?: boolean };
    result: TrustGateResult;
  };
  "trust.apply": {
    params: { cwd: string; optionId: TrustOptionId };
    result: { success: true; trusted: boolean; persisted: boolean };
  };

  // ---- long-term memory ----
  "memory.health": {
    params: Record<string, never>;
    result: MemoryHealth;
  };
  "memory.recall": {
    params: { cwd: string; q: string; limit?: number };
    result: { hits: RecallHit[] };
  };
  "memory.remember": {
    params: {
      cwd: string;
      content: string;
      type?: MemoryType;
      concepts?: string[];
      files?: string[];
    };
    result: { id: string; type: MemoryType };
  };
  "memory.forget": {
    params: {
      cwd: string;
      memoryIds?: string[];
      observationIds?: string[];
    };
    result: { deleted: number };
  };
  "memory.stats": {
    params: { cwd: string };
    result: MemoryStats;
  };

  // ---- models ----
  "models.refresh": {
    params: Record<string, never>;
    result: { sessions: number };
  };
}

export type MethodName = keyof AgentHostMethods;
export type Params<M extends MethodName> = AgentHostMethods[M]["params"];
export type Result<M extends MethodName> = AgentHostMethods[M]["result"];

/**
 * Guard used by the host to reject unknown methods before dispatch. Keep it
 * in sync with the implementations in `agent-host/`.
 */
export const IMPLEMENTED_HOST_METHODS = [
  "host.health",
  "host.shutdown",
  "host.subscribe",
  "host.unsubscribe",
  "host.transport",
  "models.providers.list",
  "models.providers.save",
  "models.providers.remove",
  "plugins.list",
  "plugins.setEnabled",
  "plugins.reload",
  "orchestrator.spawn",
  "orchestrator.list",
  "orchestrator.stop",
  "processes.list",
  "processes.start",
  "processes.stop",
  "processes.forceStop",
  "processes.restart",
  "processes.remove",
  "processes.stdin",
  "terminal.list",
  "terminal.clear",
  "terminal.shellStart",
  "terminal.shellUpdate",
  "terminal.shellFinish",
  "agent.create",
  "agent.ensure",
  "agent.command",
  "agent.state",
  "agent.keepAlive",
  "agent.destroy",
  "agent.subscribe",
  "agent.unsubscribe",
  "agent.reloadResources",
  "agent.updateCodemode",
  "mcp.probe",
  "mcp.resources",
  "mcp.readResource",
  "mcp.authStatus",
  "mcp.login",
  "mcp.cancelLogin",
  "mcp.logout",
  "mcp.refreshAuth",
  "mcp.loginStatus",
  "models.auxCatalogue",
  "models.auxConfig",
  "models.setAuxConfig",
  "image.generate",
  "decision.classify",
  "subagents.list",
  "subagents.stop",
  "env.probe",
  "toolOutput.read",
  "sessions.getBranches",
  "sessions.switchBranch",
  "workspace.cloneSession",
  "herdr.list",
  "herdr.stop",
  "fleet.list",
  "fleet.save",
  "fleet.delete",
  "fleet.import",
  "fleet.wake",
  "fleet.message",
  "sessions.locate",
  "sessions.state",
  "sessions.rename",
  "sessions.delete",
  "files.allowedRoots",
  "files.authorize",
  "files.applyCode",
  "browser.poll",
  "browser.pushSnapshot",
  "browser.resolveCommand",
  "trust.evaluate",
  "trust.apply",
  "memory.health",
  "memory.recall",
  "memory.remember",
  "memory.forget",
  "memory.stats",
  "models.refresh",
  "watchdog.status",
  "watchdog.configure",
  "watchdog.task",
  "agent.intervene",
  "api.request",
  "api.stream.close",
] as const satisfies readonly MethodName[];
