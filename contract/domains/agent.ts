/** Agent/session domain DTOs shared by the host and the Next routes. */

export type AgentModeDto = "plan" | "ask" | "full";
export type ToolPresetDto = "none" | "default" | "full";

export interface PromptImage {
  type: "image";
  /** Base64 data, no data: prefix. */
  data: string;
  mimeType: string;
}

/**
 * The existing command protocol is kept as a loose object at the wire level so
 * the 19-command whitelist has a single source of truth (`lib/agent-commands.ts`)
 * and the host can validate it at the boundary.
 */
export interface AgentCommandDto {
  type: string;
  [key: string]: unknown;
}

export type AgentLiveState = Record<string, unknown>;

export interface SessionLiveHeader {
  id: string;
  cwd: string;
  timestamp: string;
}

export interface SessionState {
  running: boolean;
  /** Present when the session is live. */
  state?: AgentLiveState;
  /** Header reported by the live AgentSession (file may not be flushed yet). */
  liveHeader?: SessionLiveHeader;
}
