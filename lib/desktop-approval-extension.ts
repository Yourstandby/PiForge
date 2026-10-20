/**
 * Inline pi extension: Ask-mode confirms for bash/write/edit.
 */
import type { ExtensionAPI, ExtensionFactory, InlineExtension } from "@earendil-works/pi-coding-agent";
import {
  askBlockResult,
  needsAskConfirm,
  summarizeToolCall,
  PLAN_MODE_SYSTEM_PROMPT,
  type AgentMode,
  type ToolPreset,
  PLAN_TOOLS,
} from "./approval-policy.ts";
import { desktopRuntimeTools, isMcpTool } from "./desktop-runtime-tools.ts";

export type AgentModeRef = { current: AgentMode; toolPreset?: ToolPreset; codemodeEnabled?: boolean };

export function createDesktopApprovalFactory(modeRef: AgentModeRef): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.on("before_agent_start", (event) => {
      const preset = modeRef.toolPreset ?? "default";
      pi.setActiveTools(desktopRuntimeTools(modeRef.current, preset, modeRef.codemodeEnabled ?? false, pi.getAllTools(), pi.getActiveTools()));
      if (modeRef.current === "plan") {
        // Appending to the options (instead of forcing a prompt) keeps pi's own
        // section rendering and the current tool loadout intact. Plan tools are
        // read-only already; this text tells the model what to deliver.
        const appended = event.systemPromptOptions.appendSystemPrompt;
        event.systemPromptOptions.appendSystemPrompt = appended
          ? `${appended}\n\n${PLAN_MODE_SYSTEM_PROMPT}`
          : PLAN_MODE_SYSTEM_PROMPT;
        return;
      }
      if (preset === "none") return { systemPrompt: "" };
    });
    pi.on("tool_call", async (event, ctx) => {
      // Native MCP can register tools asynchronously after a mode switch.
      // Enforce the desktop policy at execution as well as declaration time.
      if (modeRef.toolPreset === "none" && modeRef.current !== "plan") return askBlockResult();
      if (modeRef.current === "plan" && ![...PLAN_TOOLS, "memory_recall"].includes(event.toolName)) return askBlockResult();
      if (event.toolName === "codemode" && !modeRef.codemodeEnabled) return askBlockResult();
      const confirmMcp = modeRef.current === "ask" && isMcpTool(event.toolName);
      const confirmBg = modeRef.current === "ask" && event.toolName === "run_bg";
      if (!confirmMcp && !confirmBg && !needsAskConfirm(modeRef.current, event.toolName)) return;
      const ok = await ctx.ui.confirm(
        `允许 ${event.toolName}?`,
        summarizeToolCall(event.toolName, event.input)
      );
      if (!ok) return askBlockResult();
    });
  };
}

export function desktopApprovalInlineExtension(modeRef: AgentModeRef): InlineExtension {
  return {
    name: "desktop-approval",
    factory: createDesktopApprovalFactory(modeRef),
  };
}
