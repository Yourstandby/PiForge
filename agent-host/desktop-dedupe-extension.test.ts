import assert from "node:assert/strict";
import test from "node:test";
import {
  bashDedupeReplacement,
  contentHash,
  dedupeEnabled,
  emptyDedupeStats,
  fileStamp,
  normalizeBashCommand,
  readDedupeReplacement,
  type BashCacheEntry,
  type ReadCacheEntry,
} from "./desktop-dedupe-extension.ts";

const LONG = "x".repeat(600);

test("read dedupe only fires for the same path+range, unchanged file and identical content", () => {
  const cache = new Map<string, ReadCacheEntry>();
  const first = readDedupeReplacement({
    cache,
    key: "/repo/a.ts|10|20",
    toolCallId: "call-1",
    stamp: "100:1000",
    text: LONG,
  });
  assert.equal(first, null, "first read must return the full text");

  const second = readDedupeReplacement({
    cache,
    key: "/repo/a.ts|10|20",
    toolCallId: "call-2",
    stamp: "100:1000",
    text: LONG,
  });
  assert.match(second ?? "", /Unchanged since toolCall call-1/);

  // 文件被改过（stamp 变）→ 照常回全文
  const changed = readDedupeReplacement({
    cache,
    key: "/repo/a.ts|10|20",
    toolCallId: "call-3",
    stamp: "101:2000",
    text: LONG,
  });
  assert.equal(changed, null);
});

test("read dedupe never fires for a different range or tiny outputs", () => {
  const cache = new Map<string, ReadCacheEntry>();
  readDedupeReplacement({ cache, key: "/repo/a.ts|10|20", toolCallId: "c1", stamp: "1:1", text: LONG });
  const otherRange = readDedupeReplacement({
    cache,
    key: "/repo/a.ts|30|20",
    toolCallId: "c2",
    stamp: "1:1",
    text: LONG,
  });
  assert.equal(otherRange, null, "different offset is a different read");
  const tinyCache = new Map<string, ReadCacheEntry>();
  readDedupeReplacement({ cache: tinyCache, key: "k", toolCallId: "c1", stamp: "1:1", text: "short" });
  assert.equal(
    readDedupeReplacement({ cache: tinyCache, key: "k", toolCallId: "c2", stamp: "1:1", text: "short" }),
    null,
    "short results are not worth deduping"
  );
});

test("bash dedupe returns one line for identical output and the tail for grown output", () => {
  const cache = new Map<string, BashCacheEntry>();
  const key = normalizeBashCommand("  cat   log ");
  assert.equal(bashDedupeReplacement({ cache, key, toolCallId: "c1", text: LONG }), null);
  assert.match(
    bashDedupeReplacement({ cache, key, toolCallId: "c2", text: LONG }) ?? "",
    /identical output/
  );
  const grown = `${LONG}tail`;
  const tail = bashDedupeReplacement({ cache, key, toolCallId: "c3", text: grown }) ?? "";
  assert.match(tail, /plus 4 new chars at the end/);
  assert.match(tail, /tail$/);
  // 输出不是「旧输出 + 尾巴」（比如换了行为）→ 回全文
  const unrelated = bashDedupeReplacement({ cache, key, toolCallId: "c4", text: "y".repeat(700) });
  assert.equal(unrelated, null);
});

test("bash normalization collapses whitespace so cosmetic differences still hit", () => {
  assert.equal(normalizeBashCommand("  git   status "), "git status");
  assert.equal(normalizeBashCommand("git status\n"), "git status");
});

test("dedupe can be disabled by env (A/B measurement)", () => {
  assert.equal(dedupeEnabled({}), true);
  assert.equal(dedupeEnabled({ PIFORGE_DEDUPE_TOOL_RESULTS: "0" }), false);
  assert.equal(dedupeEnabled({ PIFORGE_DEDUPE_TOOL_RESULTS: "1" }), true);
});

test("cache eviction keeps the newest entries (LRU) and stats start empty", () => {
  const stats = emptyDedupeStats();
  assert.deepEqual(stats, {
    readHits: 0,
    bashHits: 0,
    readMisses: 0,
    bashMisses: 0,
    errorPassThroughs: 0,
  });
  const cache = new Map<string, ReadCacheEntry>();
  for (let index = 0; index < 200; index += 1) {
    readDedupeReplacement({
      cache,
      key: `file-${index}`,
      toolCallId: `c-${index}`,
      stamp: "1:1",
      text: LONG,
    });
  }
  assert.ok(cache.size <= 128, "cache is bounded");
  assert.ok(cache.has("file-199"), "newest entry survives");
});

test("fileStamp returns null for a missing file (no dedupe without proof)", () => {
  assert.equal(fileStamp("/definitely/not/here/nope.ts"), null);
});

test("contentHash is stable and short", () => {
  assert.equal(contentHash("abc"), contentHash("abc"));
  assert.notEqual(contentHash("abc"), contentHash("abd"));
  assert.equal(contentHash("abc").length, 16);
});
