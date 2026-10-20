import test from "node:test";
import assert from "node:assert/strict";
import {
  PROMPT_HISTORY_LIMIT,
  parsePromptHistory,
  pushPromptHistory,
  stepHistory,
} from "./prompt-history.ts";

test("pushPromptHistory puts the newest prompt first", () => {
  assert.deepEqual(pushPromptHistory([], "a"), ["a"]);
  assert.deepEqual(pushPromptHistory(["a"], "b"), ["b", "a"]);
});

test("pushPromptHistory skips blanks, repeats and caps the list", () => {
  assert.deepEqual(pushPromptHistory(["a"], "   "), ["a"]);
  assert.deepEqual(pushPromptHistory(["a", "b"], "a"), ["a", "b"]);
  const long = Array.from({ length: PROMPT_HISTORY_LIMIT }, (_, i) => `p${i}`);
  const next = pushPromptHistory(long, "newest");
  assert.equal(next.length, PROMPT_HISTORY_LIMIT);
  assert.equal(next[0], "newest");
});

test("parsePromptHistory tolerates corrupt storage", () => {
  assert.deepEqual(parsePromptHistory(null), []);
  assert.deepEqual(parsePromptHistory("not json"), []);
  assert.deepEqual(parsePromptHistory('{"a":1}'), []);
  assert.deepEqual(parsePromptHistory('["a", 3, "", "b"]'), ["a", "b"]);
});

test("stepHistory walks older then back to the draft", () => {
  assert.deepEqual(stepHistory(null, "older", 2), { index: 0, restoreDraft: false });
  assert.deepEqual(stepHistory(0, "older", 2), { index: 1, restoreDraft: false });
  assert.deepEqual(stepHistory(1, "older", 2), { index: 1, restoreDraft: false });
  assert.deepEqual(stepHistory(1, "newer", 2), { index: 0, restoreDraft: false });
  assert.deepEqual(stepHistory(0, "newer", 2), { index: null, restoreDraft: true });
  assert.deepEqual(stepHistory(null, "newer", 2), { index: null, restoreDraft: false });
  // No history at all: a browsing index just restores the draft.
  assert.deepEqual(stepHistory(0, "older", 0), { index: null, restoreDraft: true });
});
