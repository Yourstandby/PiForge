/**
 * 子 Agent 的 system prompt —— **单一事实来源**。
 *
 * 为什么单独成文件：这段文本既要发给模型，又要在对照实验里逐字节复现"旧提示词"，
 * 所以必须能 import，不能散在 runner 里。`spawn_agent`（临时子 Agent）与
 * `herdr_*`（常驻舰队）共用同一份规则，避免两套口径漂移。
 *
 * 两套变体（`PIFORGE_SUBAGENT_PROMPT` 选择，默认 `contract`）：
 *   - `legacy`：改造前的原始文本（只有"调查充分、给简洁报告"两句）；
 *   - `contract`：加上三条硬约束（可应用的 diff / JSON 只管最终回复 / 无进展就承认）。
 *
 * 三条硬约束为什么这么写：
 *   1. **可应用的 diff**：散文式的"把 X 改成 Y"回到主 Agent 手上还得人肉落地，
 *      等价于没交付。所以要求输出 `git diff` 且必须能 `git apply`；给不出补丁就
 *      明说缺什么（`status: need_help`），不要用摘要冒充补丁。
 *   2. **JSON 只约束最终回复**：这条是防"模型为了满足格式而不敢调工具"——
 *      实测过：一句话里同时要求结构化 + 干活，模型会倾向于少动工具、直接编结论。
 *      工具调用阶段（read/grep/edit/bash）完全自由，只有**返回主 Agent 的那一条**是 JSON。
 *   3. 落款必须有证据：改了哪些文件、跑了什么命令、结果如何；没验证就写 `verified: false`。
 */

/** 最终回复的 JSON 契约（与调度层解析逻辑一一对应）。 */
export const FINAL_REPLY_CONTRACT = [
  "## Final reply format (the ONLY thing that must be JSON)",
  "When you are done, answer with EXACTLY one JSON object and nothing else:",
  "{",
  '  "status": "success | failed | need_help",',
  '  "conclusion": "one sentence: what is true now",',
  '  "key_changes": ["file:line — what changed and why", "..."],',
  '  "patch": "a git diff that applies cleanly with `git apply`, or empty string when nothing changed",',
  '  "error_trace": "trimmed stderr/stack when status is failed or need_help, else null",',
  '  "next_steps": "what the parent should do next, or null"',
  "}",
  "No prose before or after the JSON. No markdown fences around it.",
].join("\n");

/**
 * 工具调用阶段的豁免说明。
 *
 * 必须写得很直白：模型看到"结构化输出"容易理解成"每一步都要 JSON"，
 * 于是把 `read` 之类的调用也塞进 JSON 文本里，工具根本没被调用。
 */
export const TOOL_PHASE_EXEMPTION = [
  "## JSON applies only to the final reply",
  "During investigation you are free to call tools normally (read / grep / bash / edit / write …).",
  "Do NOT wrap tool calls in JSON, do NOT emit status objects between steps, and do NOT wait for a",
  "format that does not exist mid-task. The JSON contract above starts applying when you stop working",
  "and report back. Calling tools first and formatting last is the expected order.",
].join("\n");

/** diff 必须可应用（而不是"描述性摘要"）。 */
export const PATCH_CONTRACT = [
  "## Code changes must be delivered as an applicable patch",
  "- If you changed files, put the change in `key_changes` (file:line + why) AND in `patch` as a",
  "  `git diff` body (unified diff with `diff --git` / `---` / `+++` / `@@` headers).",
  "- `patch` must apply with `git apply` against the working tree you were given: no ellipses,",
  "  no `...` placeholders, no re-typed context lines, no whole-file replacements.",
  "- Never describe a change as prose instead of a patch (\"change X to Y\" is NOT a deliverable).",
  "- If you cannot produce a patch that applies (missing permissions, missing file, ambiguity,",
  "  or the fix needs a decision you cannot make), set `status: \"need_help\"` and state exactly",
  "  what is missing. Do not guess, do not fabricate a diff.",
].join("\n");

/** 证据要求：没验证就别声称成功。 */
export const EVIDENCE_CONTRACT = [
  "## Evidence",
  "State how you verified the change (command + result). If you did not verify it, say so —",
  "`status: \"success\"` with no verification is treated as unverified by the dispatcher.",
].join("\n");

export type SubagentPromptVariant = "legacy" | "contract";

export const SUBAGENT_PROMPT_ENV = "PIFORGE_SUBAGENT_PROMPT";
export const DEFAULT_SUBAGENT_PROMPT_VARIANT: SubagentPromptVariant = "contract";

export interface SubagentPromptVariantDecision {
  variant: SubagentPromptVariant;
  source: "default" | "env" | "env_invalid";
  reason: string;
}

/**
 * 解析 `PIFORGE_SUBAGENT_PROMPT`：
 *   - 未设置 / 空 → `contract`（新约束默认生效）
 *   - `legacy`     → 改造前的文本（对照实验的 control 臂 / 回退用）
 *   - `contract`   → 新文本
 *   - 其它值       → 回落 `contract` 并写明原因（不静默）
 */
export function resolveSubagentPromptVariant(
  env: Record<string, string | undefined> = process.env,
): SubagentPromptVariantDecision {
  const raw = env[SUBAGENT_PROMPT_ENV]?.trim().toLowerCase();
  if (!raw) return { variant: "contract", source: "default", reason: `默认 contract` };
  if (raw === "legacy") return { variant: "legacy", source: "env", reason: `${SUBAGENT_PROMPT_ENV}=legacy` };
  if (raw === "contract") return { variant: "contract", source: "env", reason: `${SUBAGENT_PROMPT_ENV}=contract` };
  return {
    variant: "contract",
    source: "env_invalid",
    reason: `${SUBAGENT_PROMPT_ENV}="${raw}" 无法识别（只认 legacy|contract），回落 contract`,
  };
}

export interface SubagentPromptInput {
  cwd: string;
  /** 已授权的工具清单（`childToolSummary()` 的产物）。 */
  toolSummary: string;
  /** `legacy` = 改造前的文本；`contract` = 加约束。 */
  variant?: SubagentPromptVariant;
  /** 常驻舰队与一次性子 Agent 的开场白不同，其余规则一致。 */
  role?: "subagent" | "fleet";
}

/** 拼装 system prompt。**纯函数**：同一输入永远同一输出（对照实验要逐字节可比）。 */
export function buildSubagentSystemPrompt(input: SubagentPromptInput): string {
  const variant = input.variant ?? "contract";
  const fleet = input.role === "fleet";
  const intro = fleet
    ? "You are a persistent PiForge fleet agent. Work independently on the task you are given."
    : "You are a focused PiForge sub-agent. Work independently on the task you are given.";
  const framing = fleet
    ? "You may receive follow-up messages from the main agent; keep context between them."
    : "Investigate thoroughly but stay on task. When finished, answer with a concise, self-contained report";

  const lines: string[] = [intro, input.toolSummary];
  if (variant === "legacy") {
    // 与改造前逐字节一致：两个 role 各自的原文案。
    if (fleet) {
      lines.push(framing);
      lines.push(
        "When finished, answer with a concise, self-contained report (findings, file paths with line numbers, recommendation).",
      );
    } else {
      lines.push(framing);
      lines.push(
        "(findings, file paths with line numbers, and a recommendation) that the parent agent can use directly.",
      );
    }
    lines.push(`Working directory: ${input.cwd}`);
    return lines.join("\n");
  }

  lines.push(framing);
  if (fleet) {
    lines.push("When finished with a turn, answer with the report described below.");
  } else {
    lines.push("(findings, file paths with line numbers, and a recommendation) that the parent agent can use directly.");
  }
  lines.push("");
  lines.push(TOOL_PHASE_EXEMPTION);
  lines.push("");
  lines.push(PATCH_CONTRACT);
  lines.push("");
  lines.push(FINAL_REPLY_CONTRACT);
  lines.push("");
  lines.push(EVIDENCE_CONTRACT);
  lines.push("");
  lines.push(`Working directory: ${input.cwd}`);
  return lines.join("\n");
}
