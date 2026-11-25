import assert from "node:assert/strict";
import test from "node:test";

import {
  PROMPT_DISPATCH_STALE_MS,
  finishPromptDispatch,
  tryStartPromptDispatch,
  type PromptDispatchState,
} from "./prompt-dispatch-gate.ts";

test("a prompt dispatch gate rejects rapid re-entry until released", () => {
  const state: PromptDispatchState = { current: false };

  assert.equal(tryStartPromptDispatch(state), true);
  assert.equal(tryStartPromptDispatch(state), false);

  finishPromptDispatch(state);
  assert.equal(tryStartPromptDispatch(state), true);
});

test("闸门不会因为一轮事件丢失而永久关闭", () => {
  const state: PromptDispatchState = { current: false };

  assert.equal(tryStartPromptDispatch(state, 1_000), true);
  assert.equal(tryStartPromptDispatch(state, 2_000), false, "同一批重入仍要挡住");
  // 上一轮的 agent_end 丢了 / 宿主重启：闸门必须在窗口过后自己放开，
  // 否则之后每次发送都被静默吞掉（「发出去了但没有下一步」）。
  assert.equal(tryStartPromptDispatch(state, 1_000 + PROMPT_DISPATCH_STALE_MS + 1), true);
});
