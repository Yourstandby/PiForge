import type { ToolInfo } from "../lib/pi-types.ts";
import { effectiveToolsForMode, type AgentMode, type ToolPreset } from "../lib/approval-policy.ts";
import { withMemoryTools } from "./desktop-ltm-extension.ts";
import { BROWSER_PREVIEW_TOOL_NAME } from "./browser-bridge.ts";
import {
  CLASSIFY_DECISION_TOOL_NAME,
  GENERATE_IMAGE_TOOL_NAME,
  SPAWN_AGENT_TOOL_NAME,
} from "./aux-tool-names.ts";
import { TOOL_HISTORY_TOOL_NAME } from "./tool-outputs.ts";
import { PROCESS_READ_TOOL_NAME, PROCESS_WAIT_TOOL_NAME } from "./process-tool-names.ts";

/** Auxiliary model tools are only declared once the user configured them. */
export interface AuxToolAvailability {
  image: boolean;
  decision: boolean;
}

export function isMcpTool(name: string): boolean {
  return name.startsWith("mcp__") || ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"].includes(name);
}

/** Preserve native MCP exposure; selecting tools must not declare script-only tools. */
export function desktopRuntimeTools(mode: AgentMode, preset: ToolPreset, codemode: boolean, registered: ToolInfo[], active: string[] = [], aux?: AuxToolAvailability, platform: NodeJS.Platform = process.platform): string[] {
  const names = withMemoryTools(effectiveToolsForMode(mode, preset), mode);
  if (mode === "plan" || preset === "none") return names;
  for (const tool of registered) {
    // Native tool_search records deferred/codemode activations in the session.
    // Keep those declarations across prompts without exposing hidden tools.
    if (isMcpTool(tool.name) && (tool.exposure === "direct" ||
      (active.includes(tool.name) && ["deferred", "codemode"].includes(tool.exposure ?? "")))) names.push(tool.name);
  }
  if (registered.some((tool) => tool.name === "tool_search")) names.push("tool_search");
  // PowerShell is a first-class Windows shell when the host registered it.
  if (platform === "win32" && registered.some((tool) => tool.name === "powershell")) names.push("powershell");
  // Background processes are a desktop capability registered by our inline
  // extension; ask mode still gates them through the approval hook.
  if (registered.some((tool) => tool.name === "run_bg")) names.push("run_bg");
  // Read-only managed-process tools (no stop/restart tools by design).
  if (registered.some((tool) => tool.name === PROCESS_READ_TOOL_NAME)) names.push(PROCESS_READ_TOOL_NAME);
  if (registered.some((tool) => tool.name === PROCESS_WAIT_TOOL_NAME)) names.push(PROCESS_WAIT_TOOL_NAME);
  // Sub-agent delegation: available whenever the extension is registered.
  if (registered.some((tool) => tool.name === SPAWN_AGENT_TOOL_NAME)) names.push(SPAWN_AGENT_TOOL_NAME);
  // Oversized tool outputs are persisted; the agent reads them back by page.
  if (registered.some((tool) => tool.name === TOOL_HISTORY_TOOL_NAME)) names.push(TOOL_HISTORY_TOOL_NAME);
  // Built-in browser: Main owns the view; these tools only inspect/navigate.
  if (registered.some((tool) => tool.name === BROWSER_PREVIEW_TOOL_NAME)) names.push(BROWSER_PREVIEW_TOOL_NAME);
  if (registered.some((tool) => tool.name === "browser_read")) names.push("browser_read");
  if (registered.some((tool) => tool.name === "browser_interact")) names.push("browser_interact");
  // Herdr fleet lifecycle is Host-owned; tools are declared when registered.
  for (const name of ["herdr_spawn", "herdr_status", "herdr_message"]) {
    if (registered.some((tool) => tool.name === name)) names.push(name);
  }
  // Auxiliary model lanes: declared only when a model is configured, so a
  // session without them pays no prompt tokens for their schemas.
  if (aux?.image && registered.some((tool) => tool.name === GENERATE_IMAGE_TOOL_NAME)) names.push(GENERATE_IMAGE_TOOL_NAME);
  if (aux?.decision && registered.some((tool) => tool.name === CLASSIFY_DECISION_TOOL_NAME)) names.push(CLASSIFY_DECISION_TOOL_NAME);
  if (codemode && registered.some((tool) => tool.name === "codemode")) names.push("codemode");
  return [...new Set(names)];
}
