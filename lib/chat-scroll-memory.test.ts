import test from "node:test";
import assert from "node:assert/strict";

import { savedScrollTop } from "./chat-scroll-memory.ts";

test("a hidden pane falls back to the last known scroll position", () => {
  // display:none → clientHeight 0, scrollTop 读出来是 0。
  assert.equal(savedScrollTop(0, 0, 4200), 4200);
});

test("a visible pane keeps its real position, but ignores a bogus 0", () => {
  assert.equal(savedScrollTop(1500, 600, 1400), 1500);
  assert.equal(savedScrollTop(0, 600, 2600), 2600, "隐藏在提交帧里被读成 0 时不能当真");
  assert.equal(savedScrollTop(0, 600, 0), 0, "真的在顶部就记 0");
});
