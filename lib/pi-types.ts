import type {
  SessionManager,
  SettingsManager,
  AgentSessionEvent,
  SessionStats,
} from "@earendil-works/pi-coding-agent";

export interface ContextUsage {
  percent: number | null;
  contextWindow: number;
  tokens: number | null;
}

/** agent-host/context-budget.ts 的返回值：前端只按 level 上色。 */
export interface ContextBudget {
  tokens: number | null;
  ceiling: number;
  ratioToCeiling: number;
  ratioToWindow: number;
  level: "ok" | "warn" | "critical";
  /** 已越过硬顶（ratioToCeiling ≥ 1）：压缩马上会动手，UI 只需要一个红环 + 脉冲。 */
  overshoot: boolean;
  hint: string;
}

export interface ModelLike {
  id: string;
  provider: string;
}

export interface ToolInfo {
  name: string;
  description: string;
  exposure?: string;
}

export interface NavigateTreeResult {
  editorText?: string;
  cancelled: boolean;
  aborted?: boolean;
}

export interface AgentSessionLike {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
  readonly autoCompactionEnabled: boolean;
  readonly autoRetryEnabled: boolean;
  readonly model: ModelLike | undefined;
  /** Display name persisted via the `session_info` entry (auto titles / rename). */
  readonly sessionName?: string;
  /** Pi 0.82+: model lookup lives on modelRuntime (modelRegistry facade removed from AgentSession). */
  readonly modelRuntime: {
    getModel: (provider: string, modelId: string) => ModelLike | undefined;
    complete?: (...args: unknown[]) => Promise<unknown>;
  };
  readonly sessionManager: SessionManager;
  readonly settingsManager: SettingsManager;
  readonly agent: { state?: { systemPrompt?: string; thinkingLevel?: string } };

  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(text: string, options?: { images?: Array<{ type: "image"; data: string; mimeType: string }> }): Promise<void>;
  abort(): Promise<void>;
  dispose?(): void;
  reload?(): Promise<void>;
  extensionRunner?: { emit(event: { type: "session_shutdown"; reason: "quit" }): Promise<unknown> };
  setModel(model: ModelLike): Promise<void>;
  navigateTree(targetId: string, options?: { summarize?: boolean }): Promise<NavigateTreeResult>;
  setThinkingLevel(level: string): void;
  compact(customInstructions?: string): Promise<unknown>;
  setAutoCompactionEnabled(enabled: boolean): void;
  setAutoRetryEnabled(enabled: boolean): void;
  steer(text: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): Promise<void>;
  followUp(text: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): Promise<void>;
  getAllTools(): ToolInfo[];
  getActiveToolNames(): string[];
  setActiveToolsByName(names: string[]): void;
  abortCompaction(): void;
  setSessionName?(name: string): void;
  getContextUsage(): ContextUsage | undefined;
  getSessionStats?(): SessionStats;
  /** Pi extension bindings (desktop UI bridge). Optional on stubs. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bindExtensions?(bindings: { uiContext?: any; mode?: string }): Promise<void>;
}
