import assert from "node:assert/strict";
import test from "node:test";
import { THINKING_LEVELS, getThinkingLevelsForModel } from "./thinking-levels.ts";

test("the thinking menu offers exactly auto / medium / high", () => {
  assert.deepEqual([...THINKING_LEVELS], ["auto", "medium", "high"]);
});

test("unknown model capability keeps every option", () => {
  assert.deepEqual(getThinkingLevelsForModel(null), ["auto", "medium", "high"]);
  assert.deepEqual(getThinkingLevelsForModel(undefined), ["auto", "medium", "high"]);
});

test("auto is always available, the other two follow model support", () => {
  assert.deepEqual(getThinkingLevelsForModel([]), ["auto"]);
  assert.deepEqual(getThinkingLevelsForModel(["medium"]), ["auto", "medium"]);
  assert.deepEqual(getThinkingLevelsForModel(["low", "medium", "high"]), [
    "auto",
    "medium",
    "high",
  ]);
  // 老模型只暴露 high 以外的档位时，高质量不会硬塞进去
  assert.deepEqual(getThinkingLevelsForModel(["minimal", "low"]), ["auto"]);
});

test("every curated option maps to a real backend enum value", () => {
  const backendEnum = ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"];
  for (const level of THINKING_LEVELS) {
    assert.ok(backendEnum.includes(level), `${level} must exist in the backend enum`);
  }
});
