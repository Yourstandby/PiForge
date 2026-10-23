import assert from "node:assert/strict";
import test from "node:test";
import { THINKING_LEVELS, getThinkingLevelsForModel } from "./thinking-levels.ts";

test("the thinking menu offers exactly auto / high / medium / low", () => {
  assert.deepEqual([...THINKING_LEVELS], ["auto", "high", "medium", "low"]);
});

test("unknown model capability keeps every option", () => {
  assert.deepEqual(getThinkingLevelsForModel(null), ["auto", "high", "medium", "low"]);
  assert.deepEqual(getThinkingLevelsForModel(undefined), ["auto", "high", "medium", "low"]);
});

test("auto is always available, the other three stay regardless of the model subset", () => {
  assert.deepEqual(getThinkingLevelsForModel([]), ["auto"]);
  // 模型只暴露部分档位时仍然给出四档：后端会把不支持的档位收敛到合法值。
  assert.deepEqual(getThinkingLevelsForModel(["medium"]), ["auto", "high", "medium", "low"]);
  assert.deepEqual(getThinkingLevelsForModel(["low"]), ["auto", "high", "medium", "low"]);
  assert.deepEqual(getThinkingLevelsForModel(["low", "medium", "high"]), [
    "auto",
    "high",
    "medium",
    "low",
  ]);
});

test("every curated option maps to a real backend enum value", () => {
  const backendEnum = ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"];
  for (const level of THINKING_LEVELS) {
    assert.ok(backendEnum.includes(level), `${level} must exist in the backend enum`);
  }
});
