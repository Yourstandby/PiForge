/**
 * AgentMode + tool-preset → effective tools / Ask-confirm membership.
 * Pure policy — no I/O, no React.
 */

export type AgentMode = "plan" | "ask" | "full";
export type ToolPreset = "none" | "default" | "full";

export const PLAN_TOOLS: readonly string[] = [
  "read",
  "grep",
  "find",
  "ls",
  "tool_history_get",
  /** 多态工具：plan 模式只放行只读动作（memory.recall / shell.read / shell.wait / browser.read）。 */
  "memory",
];
export const ASK_CONFIRM_TOOLS: readonly string[] = [
  "bash",
  "powershell",
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

/**
 * 回复语言：跟随用户当前使用的语言。
 *
 * pi 自带的 prompt 不约束语言，模型在长任务里经常用英文复述下一步
 * （"Now the grouping logic + panel:"），中文对话中间夹这些很割裂。
 * 这里明确要求**包括工具调用之间的进度说明**也用用户语言，代码/路径/命令不翻译。
 */
export const RESPONSE_LANGUAGE_PROMPT = [
  "## 回复语言",
  "始终使用用户当前使用的语言回复（用户用中文就用中文，用英文就用英文）。",
  "工具调用之间的简短进度说明、步骤复述、总结也必须用同一语言——不要用英文写这些过渡句。",
  "代码、标识符、命令、文件路径保持原样，不要翻译。",
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
  if ((toolName === "bash" || toolName === "powershell") && typeof obj.command === "string") {
    const cmd = obj.command.length > 200 ? `${obj.command.slice(0, 200)}…` : obj.command;
    return `${toolName}: ${cmd}`;
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
