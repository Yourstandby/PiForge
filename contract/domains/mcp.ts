/**
 * MCP management domain (v0.5.0 stage 1).
 *
 * Every connection, OAuth flow and resource read runs in the Agent Host.
 * The Next.js side only forwards these DTOs; it never opens an MCP transport.
 */

export type McpScope = "global" | "project";

/** Addresses one configured server. `cwd` selects the project mcp.json. */
export interface McpServerRef {
  cwd?: string;
  serverId: string;
  /** Preferred scope when the same id exists in both files. */
  scope?: McpScope;
}

/** Ad-hoc connection fields used by the "test unsaved form" action. */
export interface McpConnectionConfig {
  transport?: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  cwd?: string;
}

export interface McpToolSummary {
  name: string;
  description?: string;
}

export interface McpResourceSummary {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
}

export interface McpResourceTemplateSummary {
  uriTemplate: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface McpConnectionReport {
  ok: boolean;
  message?: string;
  elapsedMs: number;
  /** True when the server rejected the request with 401 / needs a sign-in. */
  authRequired: boolean;
  toolsCount: number;
  tools: McpToolSummary[];
  resources: McpResourceSummary[];
  resourceTemplates: McpResourceTemplateSummary[];
  /** Server instructions from `initialize`, when present. */
  instructions?: string;
}

export interface McpPendingLogin {
  loginId: string;
  serverId: string;
  scope?: McpScope;
  status: "pending" | "authorized" | "failed" | "cancelled";
  authorizationUrl?: string;
  startedAt: number;
  finishedAt?: number;
  message?: string;
}

export interface McpAuthState {
  /** True when the server is an HTTP endpoint that authenticates with OAuth. */
  oauth: boolean;
  authenticated: boolean;
  hasClient: boolean;
  hasRefreshToken: boolean;
  /** Epoch milliseconds of the stored access token expiry, when the server reported one. */
  expiresAt?: number;
  scope?: string;
  login?: McpPendingLogin;
}

export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  /** Base64 for binary resources; the UI renders text only. */
  blobBase64?: string;
}

export interface McpResourceReadResult {
  contents: McpResourceContent[];
  /** True when a text resource was clipped before being sent to the renderer. */
  truncated: boolean;
}
