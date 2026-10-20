/**
 * Inline pi extension for sandboxed Host plugins (v0.7.0 module 2).
 *
 * Plugin tools are registered as ordinary agent tools with a namespaced name
 * (`plugin__<id>__<tool>`). Execution stays in plugin-manager.ts, which only
 * gives the plugin a frozen Host-RPC API over the local WebSocket bus.
 */
import { Type } from "typebox";
import type {
  ExtensionAPI,
  ExtensionFactory,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";
import {
  executePluginTool,
  listPluginTools,
  pluginPromptAdditions,
} from "./plugin-manager.ts";

function textResult(text: string, details: unknown = {}) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

export function createDesktopPluginFactory(): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.on("before_agent_start", (event) => {
      const addition = pluginPromptAdditions();
      if (!addition) return;
      const current = event.systemPromptOptions.appendSystemPrompt;
      event.systemPromptOptions.appendSystemPrompt = current
        ? `${current}\n\n[Plugin instructions]\n${addition}`
        : `[Plugin instructions]\n${addition}`;
    });

    for (const tool of listPluginTools()) {
      pi.registerTool({
        name: tool.name,
        label: tool.title,
        description: tool.description || `Plugin tool from ${tool.pluginId}`,
        promptSnippet: tool.description.slice(0, 180),
        parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
        defaultActive: true,
        async execute(_toolCallId, params, signal) {
          if (signal?.aborted) {
            return textResult("Plugin tool cancelled", { kind: "plugin", ok: false, plugin: tool.pluginId });
          }
          const result = await executePluginTool(
            tool.name,
            params && typeof params === "object" ? params as Record<string, unknown> : {},
          );
          if (!result.ok) {
            return textResult(`Plugin tool failed: ${result.error ?? "unknown error"}`, {
              kind: "plugin",
              ok: false,
              plugin: tool.pluginId,
              tool: tool.name,
              elapsedMs: result.elapsedMs,
              error: result.error,
            });
          }
          return textResult(
            typeof result.result === "string" ? result.result : JSON.stringify(result.result, null, 2),
            {
              kind: "plugin",
              ok: true,
              plugin: tool.pluginId,
              tool: tool.name,
              mcp: tool.mcp,
              elapsedMs: result.elapsedMs,
            },
          );
        },
      });
    }
  };
}

export function desktopPluginInlineExtension(): InlineExtension {
  return {
    name: "desktop-plugins",
    factory: createDesktopPluginFactory(),
  };
}
