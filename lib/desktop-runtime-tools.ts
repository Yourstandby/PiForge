import type { ToolInfo } from "./pi-types.ts";
import { effectiveToolsForMode, type AgentMode, type ToolPreset } from "./approval-policy.ts";
import { withMemoryTools } from "./desktop-ltm-extension.ts";
import { BROWSER_PREVIEW_TOOL_NAME } from "./browser-bridge.ts";

export function isMcpTool(name: string): boolean {
  return name.startsWith("mcp__") || ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"].includes(name);
}

/** Preserve native MCP exposure; selecting tools must not declare script-only tools. */
export function desktopRuntimeTools(mode: AgentMode, preset: ToolPreset, codemode: boolean, registered: ToolInfo[], active: string[] = []): string[] {
  const names = withMemoryTools(effectiveToolsForMode(mode, preset), mode);
  if (mode === "plan" || preset === "none") return names;
  for (const tool of registered) {
    // Native tool_search records deferred/codemode activations in the session.
    // Keep those declarations across prompts without exposing hidden tools.
    if (isMcpTool(tool.name) && (tool.exposure === "direct" ||
      (active.includes(tool.name) && ["deferred", "codemode"].includes(tool.exposure ?? "")))) names.push(tool.name);
  }
  if (registered.some((tool) => tool.name === "tool_search")) names.push("tool_search");
  // Background processes are a desktop capability registered by our inline
  // extension; ask mode still gates them through the approval hook.
  if (registered.some((tool) => tool.name === "run_bg")) names.push("run_bg");
  // Built-in browser inspection (read page text / screenshot) — read-only.
  if (registered.some((tool) => tool.name === BROWSER_PREVIEW_TOOL_NAME)) names.push(BROWSER_PREVIEW_TOOL_NAME);
  if (codemode && registered.some((tool) => tool.name === "codemode")) names.push("codemode");
  return [...new Set(names)];
}
