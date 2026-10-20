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
import type { TerminalBlock, TerminalBlockStatus } from "./domains/terminal.ts";
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

  // ---- managed background processes ----
  "processes.list": {
    params: Record<string, never>;
    result: { processes: ManagedProcessView[] };
  };
  "processes.start": {
    params: { cwd: string; command: string; name?: string };
    result: { process: ManagedProcessView };
  };
  "processes.stop": {
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

  // ---- development environment probes ----
  "env.probe": {
    params: { refresh?: boolean };
    result: DevEnvironmentReport;
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
  "processes.list",
  "processes.start",
  "processes.stop",
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
  "env.probe",
  "sessions.locate",
  "sessions.state",
  "sessions.rename",
  "sessions.delete",
  "files.allowedRoots",
  "files.authorize",
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
] as const satisfies readonly MethodName[];
