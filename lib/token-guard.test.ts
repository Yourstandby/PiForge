import test from "node:test";
import assert from "node:assert/strict";
import {
  RESUME_TOKENS_THRESHOLD,
  SPLIT_TOKENS_THRESHOLD,
  isPrefixInvalidated,
  resolveTokenGuards,
} from "./token-guard.ts";

test("没有前缀审计、上下文很小 → 不提示（默认零噪音）", () => {
  assert.deepEqual(resolveTokenGuards({}), []);
  assert.deepEqual(resolveTokenGuards({ contextTokens: 5_000, hasMessages: true }), []);
});

test("P2-2：工具被移除 + unexpectedChanges → 提示前缀失效（P2-2 核心用例）", () => {
  const hints = resolveTokenGuards({
    contextTokens: 267_915,
    hasMessages: true,
    prefixAudit: {
      turns: 12,
      stableTurns: 11,
      expectedChanges: 0,
      unexpectedChanges: 1,
      lastChange: { expected: false, toolsRemoved: ["shell"], sectionsChanged: ["tools"], summary: "-工具 shell" },
    },
  });
  const hint = hints.find((item) => item.kind === "prefix-invalidated");
  assert.ok(hint, "应当出现前缀失效提示");
  assert.equal(hint.estimatedTokens, 267_915);
  assert.match(hint.text, /重发 ≈268k tok/);
  assert.match(String(hint.detail), /工具被移除：shell/);
});

test("P2-2 不误报：按需域首次激活（只增不减）不提示", () => {
  const hints = resolveTokenGuards({
    contextTokens: 50_000,
    hasMessages: true,
    prefixAudit: {
      unexpectedChanges: 0,
      expectedChanges: 1,
      lastChange: { expected: true, toolsAdded: ["shell"], sectionsChanged: ["tools"], summary: "+工具 shell" },
    },
  });
  // 只有"前缀失效"这条不该出现；恢复成本提示与它无关（50k ≥ 20k 会出）
  assert.equal(hints.some((hint) => hint.kind === "prefix-invalidated"), false);
});

test("只有 tools 段变化但没移除工具 → 不提示（避免噪音）", () => {
  assert.equal(
    isPrefixInvalidated({ unexpectedChanges: 1, lastChange: { toolsRemoved: [], sectionsChanged: ["tools"] } }),
    false,
  );
  // system prompt 的其它段被改 → 算失效
  assert.equal(
    isPrefixInvalidated({ unexpectedChanges: 1, lastChange: { toolsRemoved: [], sectionsChanged: ["addendum"] } }),
    true,
  );
});

test("P2-3a：恢复大上下文会话 → 提示重发成本", () => {
  const hints = resolveTokenGuards({ contextTokens: 142_976, hasMessages: true });
  const hint = hints.find((item) => item.kind === "resume-cost");
  assert.ok(hint);
  assert.match(hint.text, /恢复这个会话将重发 ≈143k tok/);
});

test("P2-3a 阈值：低于 20k 或全新会话不提示", () => {
  assert.deepEqual(resolveTokenGuards({ contextTokens: RESUME_TOKENS_THRESHOLD - 1, hasMessages: true }), []);
  assert.deepEqual(resolveTokenGuards({ contextTokens: RESUME_TOKENS_THRESHOLD, hasMessages: false }), []);
  assert.equal(
    resolveTokenGuards({ contextTokens: RESUME_TOKENS_THRESHOLD, hasMessages: true }).length,
    1,
  );
});

test("会话过长提示：≥200k 时出现，且与恢复提示可共存", () => {
  const hints = resolveTokenGuards({ contextTokens: SPLIT_TOKENS_THRESHOLD, hasMessages: true });
  assert.deepEqual(
    hints.map((hint) => hint.kind).sort(),
    ["resume-cost", "session-too-long"],
  );
  assert.deepEqual(resolveTokenGuards({ contextTokens: SPLIT_TOKENS_THRESHOLD - 1, hasMessages: true }).map((h) => h.kind), [
    "resume-cost",
  ]);
});

test("用户关掉过的提示类型不再出现（本会话内）", () => {
  const base = { contextTokens: 300_000, hasMessages: true };
  assert.equal(resolveTokenGuards(base).length, 2);
  assert.deepEqual(
    resolveTokenGuards({ ...base, dismissed: ["resume-cost", "session-too-long"] }),
    [],
  );
});

test("非法 token 数（null/NaN/负数）不会被当成大上下文", () => {
  for (const value of [null, undefined, Number.NaN, -1, 0]) {
    assert.deepEqual(resolveTokenGuards({ contextTokens: value, hasMessages: true }), []);
  }
});
