import type { ToolInfo } from "../lib/pi-types.ts";
import { effectiveToolsForMode, type AgentMode, type ToolPreset } from "../lib/approval-policy.ts";
import {
  ALWAYS_DECLARED_DOMAINS,
  ON_DEMAND_DOMAINS,
  enabledOnDemandDomains,
} from "../lib/domain-tools.ts";
import { CLASSIFY_DECISION_TOOL_NAME, GENERATE_IMAGE_TOOL_NAME } from "./aux-tool-names.ts";
import { TOOL_HISTORY_TOOL_NAME } from "./tool-outputs.ts";
import { TOOL_USE_TOOL_NAME } from "./tool-stubs.ts";

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
  // platform 保留在签名里：历史上 Windows 才声明 powershell，现在它收进 shell 多态工具，
  // 平台差异由 shell 的 action 表（exec 只在 win32 注册）决定。
  void platform;
  // memory 是「按需域」：默认不声明，plan 模式通过 PLAN_TOOLS 显式带上只读 recall。
  const names = effectiveToolsForMode(mode, preset);
  if (mode === "plan" || preset === "none") return names;
  for (const tool of registered) {
    // Native tool_search records deferred/codemode activations in the session.
    // Keep those declarations across prompts without exposing hidden tools.
    if (isMcpTool(tool.name) && (tool.exposure === "direct" ||
      (active.includes(tool.name) && ["deferred", "codemode"].includes(tool.exposure ?? "")))) names.push(tool.name);
  }
  if (registered.some((tool) => tool.name === "tool_search")) names.push("tool_search");
  // 存根的点名加载通道（MCP 直曝 / 插件工具只能靠它拉回来）。
  if (registered.some((tool) => tool.name === TOOL_USE_TOOL_NAME)) names.push(TOOL_USE_TOOL_NAME);
  // 多态工具：常驻域恒声明；按需域必须先被 `tool_search` 激活（active）才声明 ——
  // 这一声明变化只发生一次，之后 latched loadout 保证前缀字节稳定。
  for (const domain of ALWAYS_DECLARED_DOMAINS) {
    if (registered.some((tool) => tool.name === domain)) names.push(domain);
  }
  const onDemand = enabledOnDemandDomains();
  for (const domain of ON_DEMAND_DOMAINS) {
    if (!registered.some((tool) => tool.name === domain)) continue;
    // 默认（未开启按需）两个域常驻声明；开启后只有被 tool_search 激活过的才声明。
    if (!onDemand.includes(domain) || active.includes(domain)) names.push(domain);
  }
  // Oversized tool outputs are persisted; the agent reads them back by page.
  if (registered.some((tool) => tool.name === TOOL_HISTORY_TOOL_NAME)) names.push(TOOL_HISTORY_TOOL_NAME);
  // Sandboxed plugins: always visible when the plugin manager loaded them.
  // Plan mode returned above, so plugin tools (which may request Host writes
  // through RPC) stay out of read-only plans.
  for (const tool of registered) {
    if (tool.name.startsWith("plugin__")) names.push(tool.name);
  }
  // Auxiliary model lanes: declared only when a model is configured, so a
  // session without them pays no prompt tokens for their schemas.
  if (aux?.image && registered.some((tool) => tool.name === GENERATE_IMAGE_TOOL_NAME)) names.push(GENERATE_IMAGE_TOOL_NAME);
  if (aux?.decision && registered.some((tool) => tool.name === CLASSIFY_DECISION_TOOL_NAME)) names.push(CLASSIFY_DECISION_TOOL_NAME);
  if (codemode && registered.some((tool) => tool.name === "codemode")) names.push("codemode");
  return [...new Set(names)];
}
