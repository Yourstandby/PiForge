import test from "node:test";
import assert from "node:assert/strict";
import {
  RESUME_IDLE_MS,
  RESUME_TOKENS_THRESHOLD,
  SPLIT_TOKENS_THRESHOLD,
  estimateContextTokens,
  isPrefixInvalidated,
  resolveSessionSplitHint,
  resolveTokenGuards,
} from "./token-guard.ts";

/** 固定“现在”，避免测试随真实时钟漂移。 */
const NOW = Date.parse("2026-10-22T12:00:00.000Z");

assert.equal(RESUME_IDLE_MS, 10 * 60_000);

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

test("P2-3a：闲置过的大上下文会话 → 提示重发成本", () => {
  const hints = resolveTokenGuards({
    contextTokens: 142_976,
    hasMessages: true,
    lastActivityAt: new Date(NOW - 42 * 60_000).toISOString(),
    now: NOW,
  });
  const hint = hints.find((item) => item.kind === "resume-cost");
  assert.ok(hint);
  assert.match(hint.text, /闲置 42 分钟后恢复，将重发 ≈143k tok/);
});

test("P2-3a 不误报：新会话 / 刚活动 / 无活动时间都不提示", () => {
  const base = { contextTokens: 43_000, hasMessages: true, now: NOW };
  // 新会话：modified 就是此刻 → 不是恢复
  assert.deepEqual(resolveTokenGuards({ ...base, lastActivityAt: new Date(NOW - 30_000).toISOString() }), []);
  // 闲置 9 分钟：不到阈值
  assert.deepEqual(
    resolveTokenGuards({ ...base, lastActivityAt: new Date(NOW - 9 * 60_000).toISOString() }),
    [],
  );
  // 没有活动时间：无从判断，宁可不说话
  assert.deepEqual(resolveTokenGuards(base), []);
  assert.deepEqual(resolveTokenGuards({ ...base, lastActivityAt: "not-a-date" }), []);
  // 刚过阈值：出现，且能接受 ms 时间戳
  const hints = resolveTokenGuards({ ...base, lastActivityAt: NOW - 10 * 60_000 });
  assert.deepEqual(hints.map((hint) => hint.kind), ["resume-cost"]);
});

test("P2-3a 阈值：低于 20k 或全新会话不提示", () => {
  const idle = new Date(NOW - 30 * 60_000).toISOString();
  assert.deepEqual(
    resolveTokenGuards({ contextTokens: RESUME_TOKENS_THRESHOLD - 1, hasMessages: true, lastActivityAt: idle, now: NOW }),
    [],
  );
  assert.deepEqual(
    resolveTokenGuards({ contextTokens: RESUME_TOKENS_THRESHOLD, hasMessages: false, lastActivityAt: idle, now: NOW }),
    [],
  );
  assert.equal(
    resolveTokenGuards({ contextTokens: RESUME_TOKENS_THRESHOLD, hasMessages: true, lastActivityAt: idle, now: NOW })
      .length,
    1,
  );
});

test("会话过长提示：≥200k 时出现，且与恢复提示可共存", () => {
  const idle = new Date(NOW - 30 * 60_000).toISOString();
  const hints = resolveTokenGuards({
    contextTokens: SPLIT_TOKENS_THRESHOLD,
    hasMessages: true,
    lastActivityAt: idle,
    now: NOW,
  });
  assert.deepEqual(
    hints.map((hint) => hint.kind).sort(),
    ["resume-cost", "session-too-long"],
  );
  // 会话过长只看上下文大小，与是否恢复无关：刚活动的会话只出这一条
  assert.deepEqual(
    resolveTokenGuards({ contextTokens: SPLIT_TOKENS_THRESHOLD - 1, hasMessages: true, now: NOW }).map((h) => h.kind),
    [],
  );
  assert.deepEqual(
    resolveTokenGuards({ contextTokens: SPLIT_TOKENS_THRESHOLD - 1, hasMessages: true, lastActivityAt: idle, now: NOW }).map(
      (h) => h.kind,
    ),
    ["resume-cost"],
  );
});

test("用户关掉过的提示类型不再出现（本会话内）", () => {
  const base = {
    contextTokens: 300_000,
    hasMessages: true,
    lastActivityAt: new Date(NOW - 30 * 60_000).toISOString(),
    now: NOW,
  };
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

test("estimateContextTokens：CJK≈1 字/token、其它≈4 字符/token，且跳过空消息", () => {
  assert.equal(estimateContextTokens(null), 0);
  assert.equal(estimateContextTokens([]), 0);
  assert.equal(
    estimateContextTokens([
      { role: "user", content: [{ type: "text", text: "你好世界" }] }, // 4 CJK
      { role: "assistant", content: [{ type: "text", text: "abcdefgh" }] }, // 8/4 = 2
      { role: "toolResult", content: "tool output text" }, // 16/4 = 4
      { role: "assistant", content: [{ type: "toolCall", name: "bash" }] }, // 无文本 → 0
    ]),
    10,
  );
});

// ---------------------------------------------------------------------------
// L-B 实验开关（PIFORGE_SESSION_SPLIT_HINT）
// ---------------------------------------------------------------------------

test("resolveSessionSplitHint: 未设置 → 关闭（默认行为不变）", () => {
  const setting = resolveSessionSplitHint({});
  assert.equal(setting.enabled, false);
  assert.equal(setting.source, "default");
});

test("resolveSessionSplitHint: 1/true/on/yes → 开；0/false/off/no → 关", () => {
  for (const raw of ["1", "true", "on", "yes", " TRUE "]) {
    assert.equal(resolveSessionSplitHint({ PIFORGE_SESSION_SPLIT_HINT: raw }).enabled, true, raw);
  }
  for (const raw of ["0", "false", "off", "no"]) {
    assert.equal(resolveSessionSplitHint({ PIFORGE_SESSION_SPLIT_HINT: raw }).enabled, false, raw);
  }
});

test("resolveSessionSplitHint: 非法值保持关闭并写明原因（不静默）", () => {
  const setting = resolveSessionSplitHint({ PIFORGE_SESSION_SPLIT_HINT: "maybe" });
  assert.equal(setting.enabled, false);
  assert.equal(setting.source, "env_invalid");
  assert.match(setting.reason, /maybe/);
});

test("L-B 关闭时输出与引入开关前逐字节一致（无 action 字段、文案不变）", () => {
  const baseline = resolveTokenGuards({ contextTokens: 250_000, hasMessages: true });
  for (const flags of [undefined, {}, { sessionSplitHint: false }]) {
    const output = resolveTokenGuards({ contextTokens: 250_000, hasMessages: true, flags });
    assert.deepEqual(output, baseline);
    assert.equal(output.some((hint) => hint.action !== undefined), false);
  }
  const tooLong = baseline.find((hint) => hint.kind === "session-too-long");
  assert.equal(tooLong?.text, "当前会话上下文 ≈250k tok，每轮都要重读");
});

test("L-B 打开时只改 session-too-long 这一条（kind/阈值不变，多一个动作入口）", () => {
  const off = resolveTokenGuards({ contextTokens: 250_000, hasMessages: true });
  const on = resolveTokenGuards({
    contextTokens: 250_000,
    hasMessages: true,
    flags: { sessionSplitHint: true },
  });
  assert.deepEqual(
    on.map((hint) => hint.kind),
    off.map((hint) => hint.kind),
  );
  const onTooLong = on.find((hint) => hint.kind === "session-too-long");
  assert.equal(onTooLong?.action, "new-session");
  assert.match(String(onTooLong?.text), /建议开新会话/);
  assert.equal(onTooLong?.estimatedTokens, 250_000);
  // 其它提示（恢复成本）完全不受影响
  const offResume = off.find((hint) => hint.kind === "resume-cost");
  const onResume = on.find((hint) => hint.kind === "resume-cost");
  assert.deepEqual(onResume, offResume);
});

test("L-B 打开也不会在阈值以下出现提示", () => {
  const output = resolveTokenGuards({
    contextTokens: 199_999,
    hasMessages: true,
    flags: { sessionSplitHint: true },
  });
  assert.equal(output.some((hint) => hint.kind === "session-too-long"), false);
});
