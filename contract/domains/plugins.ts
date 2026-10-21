/** Host-loaded plugin registry and sandbox-safe public views. */

export type PluginStatus = "loaded" | "disabled" | "error";

export interface PluginToolView {
  /** Fully-qualified agent tool name, e.g. plugin__demo__search. */
  name: string;
  title: string;
  description: string;
  /** Whether the tool is exposed as a native MCP-style tool. */
  mcp: boolean;
}

export interface PluginPanelView {
  id: string;
  title: string;
  /** Plain text only; the renderer never injects plugin HTML. */
  body: string;
}

export interface PluginView {
  id: string;
  name: string;
  version: string;
  description: string;
  status: PluginStatus;
  enabled: boolean;
  tools: PluginToolView[];
  panels: PluginPanelView[];
  prompts: number;
  error?: string;
  loadedAt: number | null;
}

export interface PluginToolResult {
  ok: boolean;
  /** JSON-serializable handler result. */
  result?: unknown;
  error?: string;
  elapsedMs: number;
}
