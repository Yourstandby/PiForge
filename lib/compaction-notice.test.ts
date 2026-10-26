import test from "node:test";
import assert from "node:assert/strict";
import { compactionNoticeText } from "./compaction-notice.ts";

test("压缩前后都有数字：给出 497k → 31k", () => {
  assert.equal(
    compactionNoticeText({ tokensBefore: 497_891, tokensAfter: 31_200 }),
    "上下文已自动压缩：≈498k → ≈31k tok",
  );
});

test("只有压缩前：退化成单边数字", () => {
  assert.equal(
    compactionNoticeText({ tokensBefore: 100_000, tokensAfter: null }),
    "上下文已自动压缩（压缩前 ≈100k tok）",
  );
});

test("没有数字时也给一句话，不留空提醒", () => {
  assert.equal(compactionNoticeText({ tokensBefore: null, tokensAfter: null }), "上下文已自动压缩，历史摘要已生成");
});
