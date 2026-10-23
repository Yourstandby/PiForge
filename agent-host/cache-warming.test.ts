import assert from "node:assert/strict";
import test from "node:test";
import {
  CACHE_WARMING_MODES,
  DESKTOP_DEFAULT_CACHE_WARMING,
  applyCacheWarmingPolicy,
  describeCacheWarming,
  isCacheWarmingMode,
  resolveCacheWarmingMode,
  warmPromptPrefix,
} from "./cache-warming.ts";

test("cache warming defaults to idle on desktop (pi defaults to streaming)", () => {
  assert.equal(DESKTOP_DEFAULT_CACHE_WARMING, "idle");
  assert.equal(resolveCacheWarmingMode(undefined), "idle");
  assert.equal(resolveCacheWarmingMode("stale-value"), "idle");
  for (const mode of CACHE_WARMING_MODES) {
    assert.equal(resolveCacheWarmingMode(mode), mode);
    assert.ok(isCacheWarmingMode(mode));
  }
});

test("applyCacheWarmingPolicy persists the resolved mode once and is idempotent", () => {
  const applied: string[] = [];
  let current: string | undefined;
  const inner = {
    settingsManager: { getCacheWarmingMode: () => current },
    setCacheWarmingMode: (mode: string) => {
      applied.push(mode);
      current = mode;
    },
  };
  assert.equal(applyCacheWarmingPolicy(inner, undefined), "idle");
  assert.deepEqual(applied, ["idle"], "undefined setting must become the desktop default");
  applyCacheWarmingPolicy(inner, undefined);
  assert.deepEqual(applied, ["idle"], "no second write when the mode already matches");
  applyCacheWarmingPolicy(inner, "off");
  assert.deepEqual(applied, ["idle", "off"]);
});

test("applyCacheWarmingPolicy never throws when the session cannot persist settings", () => {
  const inner = {
    setCacheWarmingMode: () => {
      throw new Error("settings are read-only");
    },
  };
  assert.equal(applyCacheWarmingPolicy(inner, "streaming"), "streaming");
});

test("describeCacheWarming reports the real mode and warmer state", () => {
  const view = describeCacheWarming(
    {
      settingsManager: { getCacheWarmingMode: () => "idle" },
      cacheWarmingStatus: { state: "scheduled", nextWarmAt: 123, reason: "armed" },
    } as never,
    "idle"
  );
  assert.equal(view.mode, "idle");
  assert.equal(view.state, "scheduled");
  assert.equal(view.nextWarmAt, 123);
  assert.equal(view.reason, "armed");

  const inactive = describeCacheWarming(
    { cacheWarmingStatus: { state: "weird" } } as never,
    "off"
  );
  assert.equal(inactive.mode, "off");
  assert.equal(inactive.state, "unknown");
});

test("warmPromptPrefix skips a brand-new session (no system prompt yet)", async () => {
  const result = await warmPromptPrefix({ agent: { state: { messages: [], tools: [] } } });
  assert.equal(result.sent, false);
  assert.match(result.reason, /no system prompt/);
});

test("warmPromptPrefix replays system prompt + non-system messages with maxTokens 1", async () => {
  const calls: Array<{ context: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const result = await warmPromptPrefix({
    model: { id: "m" },
    agent: {
      state: {
        systemPrompt: "SYSTEM",
        messages: [
          { role: "system", content: "persisted system" },
          { role: "user", content: "hi" },
        ],
        tools: [{ name: "read" }],
      },
    },
    modelRuntime: {
      streamSimple(_model, context, options) {
        calls.push({ context, options });
        return { result: async () => ({ stopReason: "end_turn" }) };
      },
    },
  });
  assert.equal(result.sent, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.maxTokens, 1);
  assert.equal(calls[0].context.systemPrompt, "SYSTEM");
  // 恢复的 transcript 里已经有 system 消息：不能再传一遍，否则前缀会多出整段 system prompt。
  assert.deepEqual(calls[0].context.messages, [{ role: "user", content: "hi" }]);
});

test("warmPromptPrefix reports provider errors that resolve instead of throwing", async () => {
  const result = await warmPromptPrefix({
    model: { id: "m" },
    agent: { state: { systemPrompt: "SYSTEM", messages: [], tools: [] } },
    modelRuntime: {
      streamSimple() {
        return { result: async () => ({ stopReason: "error", errorMessage: "boom" }) };
      },
    },
  });
  assert.equal(result.sent, false);
  assert.equal(result.reason, "boom");
});

test("warmPromptPrefix skips while the session is streaming", async () => {
  const result = await warmPromptPrefix({ isStreaming: true });
  assert.equal(result.sent, false);
  assert.match(result.reason, /streaming/);
});
