import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyPromptComplexity,
  pickAutoTargets,
  resolveAutoModel,
} from "./model-routing.ts";

const models = [
  { provider: "anthropic", id: "claude-haiku-4", name: "Claude Haiku 4" },
  { provider: "anthropic", id: "claude-opus-4", name: "Claude Opus 4" },
  { provider: "openai", id: "gpt-5-mini", name: "GPT-5 mini" },
  { provider: "openai", id: "gpt-5", name: "GPT-5" },
];

test("pickAutoTargets selects a small fast model and a strong model", () => {
  const targets = pickAutoTargets(models, { provider: "openai", modelId: "gpt-5" });
  assert.equal(targets.strong?.modelId, "gpt-5");
  assert.match(targets.fast?.modelId ?? "", /haiku|mini/);
});

test("classifyPromptComplexity routes short edits to fast", () => {
  assert.equal(classifyPromptComplexity("rename this variable"), "fast");
  assert.equal(classifyPromptComplexity("修复一下这个错别字"), "fast");
});

test("classifyPromptComplexity routes design/debug work and images to strong", () => {
  assert.equal(classifyPromptComplexity("Why does the auth middleware deadlock?"), "strong");
  assert.equal(classifyPromptComplexity("重构会话加载逻辑，分析一下竞态"), "strong");
  assert.equal(classifyPromptComplexity("look", true), "strong");
  assert.equal(classifyPromptComplexity("```ts\nconst a = 1;\n```"), "strong");
  assert.equal(classifyPromptComplexity("x".repeat(500)), "strong");
});

test("resolveAutoModel falls back to the other tier when one is missing", () => {
  const only = { fast: null, strong: { provider: "p", modelId: "s" } };
  assert.deepEqual(resolveAutoModel(only, "fast"), { provider: "p", modelId: "s" });
  assert.equal(resolveAutoModel({ fast: null, strong: null }, "strong"), null);
});
