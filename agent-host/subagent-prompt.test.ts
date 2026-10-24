import test from "node:test";
import assert from "node:assert/strict";
import {
  FINAL_REPLY_CONTRACT,
  PATCH_CONTRACT,
  TOOL_PHASE_EXEMPTION,
  buildSubagentSystemPrompt,
  resolveSubagentPromptVariant,
} from "./subagent-prompt.ts";

const base = { cwd: "D:\\repo", toolSummary: "Tools granted: bash, read." };

test("默认 variant 是 contract（未设置环境变量）", () => {
  const decision = resolveSubagentPromptVariant({});
  assert.equal(decision.variant, "contract");
  assert.equal(decision.source, "default");
});

test("PIFORGE_SUBAGENT_PROMPT=legacy 可回退；非法值回落 contract 并写明原因", () => {
  assert.equal(resolveSubagentPromptVariant({ PIFORGE_SUBAGENT_PROMPT: "legacy" }).variant, "legacy");
  assert.equal(resolveSubagentPromptVariant({ PIFORGE_SUBAGENT_PROMPT: " CONTRACT " }).variant, "contract");
  const bad = resolveSubagentPromptVariant({ PIFORGE_SUBAGENT_PROMPT: "json" });
  assert.equal(bad.variant, "contract");
  assert.equal(bad.source, "env_invalid");
  assert.match(bad.reason, /json/);
});

test("legacy 变体与改造前的文本逐字节一致（对照实验的 control 臂）", () => {
  const sub = buildSubagentSystemPrompt({ ...base, variant: "legacy" });
  assert.equal(
    sub,
    [
      "You are a focused PiForge sub-agent. Work independently on the task you are given.",
      "Tools granted: bash, read.",
      "Investigate thoroughly but stay on task. When finished, answer with a concise, self-contained report",
      "(findings, file paths with line numbers, and a recommendation) that the parent agent can use directly.",
      "Working directory: D:\\repo",
    ].join("\n"),
  );
  const fleet = buildSubagentSystemPrompt({ ...base, variant: "legacy", role: "fleet" });
  assert.match(fleet, /persistent PiForge fleet agent/);
  assert.match(fleet, /keep context between them/);
  // legacy 里绝不能出现 JSON / patch 约束
  assert.equal(fleet.includes("status"), false);
  assert.equal(sub.includes("git apply"), false);
});

test("contract 变体包含三条硬约束，且工具阶段豁免写清楚了", () => {
  const prompt = buildSubagentSystemPrompt({ ...base, variant: "contract" });
  // 约束 1：diff 必须能 git apply
  assert.ok(prompt.includes(PATCH_CONTRACT));
  assert.match(prompt, /git apply/);
  assert.match(prompt, /need_help/);
  assert.match(prompt, /Never describe a change as prose instead of a patch/);
  // 约束 2：JSON 只管最终回复
  assert.ok(prompt.includes(TOOL_PHASE_EXEMPTION));
  assert.match(prompt, /Only the final reply|only to the final reply/i);
  assert.match(prompt, /free to call tools normally/);
  assert.match(prompt, /Do NOT wrap tool calls in JSON/);
  // 最终回复契约
  assert.ok(prompt.includes(FINAL_REPLY_CONTRACT));
  for (const key of ["status", "conclusion", "key_changes", "patch", "error_trace", "next_steps"]) {
    assert.match(prompt, new RegExp(`"${key}"`), `JSON contract must mention ${key}`);
  }
});

test("contract 变体仍然保留 cwd 与工具清单（不能因为加约束丢上下文）", () => {
  const prompt = buildSubagentSystemPrompt({ ...base, variant: "contract" });
  assert.ok(prompt.includes("Tools granted: bash, read."));
  assert.ok(prompt.includes("Working directory: D:\\repo"));
});

test("同一输入输出稳定（对照实验需要逐字节可比）", () => {
  const first = buildSubagentSystemPrompt({ ...base, variant: "contract" });
  const second = buildSubagentSystemPrompt({ ...base, variant: "contract" });
  assert.equal(first, second);
  // 不掺任何时间戳 / 随机量
  assert.equal(/\d{4}-\d{2}-\d{2}T/.test(first), false);
});

test("fleet 与 subagent 只有开场白不同，约束部分一致", () => {
  const sub = buildSubagentSystemPrompt({ ...base, variant: "contract", role: "subagent" });
  const fleet = buildSubagentSystemPrompt({ ...base, variant: "contract", role: "fleet" });
  assert.match(sub, /focused PiForge sub-agent/);
  assert.match(fleet, /persistent PiForge fleet agent/);
  for (const block of [PATCH_CONTRACT, FINAL_REPLY_CONTRACT, TOOL_PHASE_EXEMPTION]) {
    assert.ok(sub.includes(block) && fleet.includes(block));
  }
});

test("子 Agent prompt 不含任何禁用项（不注入动态内容、不改前缀契约）", () => {
  const prompt = buildSubagentSystemPrompt({ ...base, variant: "contract" });
  // 不得把 token 前缀相关的手段写进子 Agent prompt（避免影响主会话的缓存基线）
  assert.equal(/PIFORGE_PREFIX|prompt-prefix/.test(prompt), false);
  // 不得要求"每条消息都 JSON"（这正是约束 2 要防的误读）
  assert.equal(/every (message|turn) must be JSON/i.test(prompt), false);
});
