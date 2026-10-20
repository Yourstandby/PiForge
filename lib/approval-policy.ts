/**
 * AgentMode + tool-preset → effective tools / Ask-confirm membership.
 * Pure policy — no I/O, no React.
 */

export type AgentMode = "plan" | "ask" | "full";
export type ToolPreset = "none" | "default" | "full";

export const PLAN_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];
export const ASK_CONFIRM_TOOLS: readonly string[] = [
  "bash",
  "write",
  "edit",
  // LTM write/delete channels mutate durable project memory; keep them behind
  // the same Ask confirm as filesystem writes.
  "memory_save",
  "memory_forget",
];

export const PRESET_NONE: readonly string[] = [];
export const PRESET_DEFAULT: readonly string[] = ["read", "bash", "edit", "write"];
export const PRESET_FULL: readonly string[] = ["bash", "read", "edit", "write", "grep", "find", "ls"];

export const DEFAULT_AGENT_MODE: AgentMode = "full";
export const DEFAULT_TOOL_PRESET: ToolPreset = "default";

export const EXECUTE_PLAN_PROMPT =
  "计划已批准，请按你刚才的计划开始执行。需要写入文件或运行命令前会请求我确认。";

/**
 * Appended to the system prompt while plan mode is on.
 *
 * Plan mode also strips write tools (PLAN_TOOLS) at the policy layer; this
 * text tells the model what to produce instead of silently failing tool calls.
 */
export const PLAN_MODE_SYSTEM_PROMPT = [
  "## 计划模式（Plan Mode）",
  "本轮只做规划，不做实施：",
  "- 不要调用 write / edit 等修改文件的工具，也不要执行会改变磁盘或系统状态的命令。",
  "- 需要理解代码时用 read / grep / find / ls 等只读工具，引用关键文件与行号。",
  "输出一份用户可审阅的计划：",
  "1. 目标复述（1-2 句）",
  '2. 修改清单：每项写明 `路径:行号` + 改什么 + 为什么',
  "3. 风险 / 可选项（如有）",
  "4. 验证方式（测试 / 构建 / 手动检查）",
  "计划写完就停下等待批准；用户批准后会切到执行模式，你才开始改代码。",
].join("\n");

export function isAgentMode(value: unknown): value is AgentMode {
  return value === "plan" || value === "ask" || value === "full";
}

export function isToolPreset(value: unknown): value is ToolPreset {
  return value === "none" || value === "default" || value === "full";
}

export function toolNamesForPreset(preset: ToolPreset): string[] {
  if (preset === "none") return [...PRESET_NONE];
  if (preset === "full") return [...PRESET_FULL];
  return [...PRESET_DEFAULT];
}

/**
 * Tools actually enabled for the session given mode + preset.
 * Plan always forces the four read-side tools (even if preset is none).
 */
export function effectiveToolsForMode(mode: AgentMode, preset: ToolPreset): string[] {
  if (mode === "plan") return [...PLAN_TOOLS];
  return toolNamesForPreset(preset);
}

/** Whether Ask mode requires a confirm dialog before this tool runs. */
export function needsAskConfirm(mode: AgentMode, toolName: string): boolean {
  if (mode !== "ask") return false;
  return (ASK_CONFIRM_TOOLS as readonly string[]).includes(toolName);
}

export function askBlockResult(): { block: true; reason: string } {
  return { block: true, reason: "Blocked by user (Ask mode)" };
}

/** Short human-readable summary for confirm dialogs. */
export function summarizeToolCall(toolName: string, input: unknown): string {
  if (!input || typeof input !== "object") {
    return `${toolName}(${JSON.stringify(input ?? {})})`;
  }
  const obj = input as Record<string, unknown>;
  if (toolName === "bash" && typeof obj.command === "string") {
    const cmd = obj.command.length > 200 ? `${obj.command.slice(0, 200)}…` : obj.command;
    return `bash: ${cmd}`;
  }
  if ((toolName === "write" || toolName === "edit") && typeof obj.path === "string") {
    return `${toolName}: ${obj.path}`;
  }
  if (typeof obj.file_path === "string") {
    return `${toolName}: ${obj.file_path}`;
  }
  try {
    const s = JSON.stringify(obj);
    return s.length > 240 ? `${toolName}: ${s.slice(0, 240)}…` : `${toolName}: ${s}`;
  } catch {
    return toolName;
  }
}
