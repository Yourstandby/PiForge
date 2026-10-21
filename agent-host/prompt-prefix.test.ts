import test from "node:test";
import assert from "node:assert/strict";
import {
  STATIC_CWD_SECTION,
  buildPrefixSnapshot,
  canonicalToolOrder,
  compareToolName,
  diffPrefixSnapshots,
  estimatePrefixTokens,
  userContextBlock,
} from "./prompt-prefix.ts";

test("tool order is ASCII, not locale: uppercase sorts before lowercase", () => {
  assert.deepEqual(canonicalToolOrder(["mcp__alpha", "mcp__Zeta", "bash"]), [
    "bash",
    "mcp__Zeta",
    "mcp__alpha",
  ]);
  // localeCompare 会把 alpha 排到 Zeta 前面 —— 那正是缓存杀手。
  assert.equal(compareToolName("mcp__Zeta", "mcp__alpha"), -1);
});

test("tool order is deduped and idempotent", () => {
  const once = canonicalToolOrder(["read", "bash", "read", "edit"]);
  assert.deepEqual(once, ["bash", "edit", "read"]);
  assert.deepEqual(canonicalToolOrder(once), once);
});

test("identical inputs produce byte-identical snapshots", () => {
  const options = {
    appendSystemPrompt: "custom",
    cwd: STATIC_CWD_SECTION,
    sections: { plan: "P" },
    contextFiles: [{ path: "AGENTS.md", content: "# rules" }],
    skills: [{ name: "frontend-design", description: "d" }],
    toolSnippets: { bash: "run", read: "read" },
  };
  const a = buildPrefixSnapshot(options, ["read", "bash"]);
  const b = buildPrefixSnapshot(options, ["bash", "read"]);
  assert.deepEqual(a, b, "工具入参顺序不同、集合相同时快照必须一致");
  assert.equal(diffPrefixSnapshots(a, b).identical, true);
});

test("snapshot sections are insensitive to object key order", () => {
  const a = buildPrefixSnapshot({ sections: { a: "1", b: "2" } }, ["read"]);
  const b = buildPrefixSnapshot({ sections: { b: "2", a: "1" } }, ["read"]);
  assert.deepEqual(a, b);
});

test("diff names the changed section and the first differing character", () => {
  const before = buildPrefixSnapshot({ appendSystemPrompt: "hello world" }, ["bash"]);
  const after = buildPrefixSnapshot({ appendSystemPrompt: "hello there" }, ["bash"]);
  const diff = diffPrefixSnapshots(before, after);
  assert.equal(diff.identical, false);
  assert.deepEqual(diff.sectionsChanged, ["addendum"]);
  assert.equal(diff.firstDivergence?.section, "addendum");
  assert.equal(diff.firstDivergence?.at, 6);
  assert.match(diff.summary, /改段 addendum/);
  assert.match(diff.summary, /首处差异 @6/);
});

test("diff reports added / removed / reordered tools", () => {
  const base = buildPrefixSnapshot({}, ["bash", "read"]);
  const reordered = buildPrefixSnapshot({}, ["bash", "edit"]);
  const diff = diffPrefixSnapshots(base, reordered);
  assert.deepEqual(diff.toolsAdded, ["edit"]);
  assert.deepEqual(diff.toolsRemoved, ["read"]);
  assert.equal(diff.toolsReordered, false);

  const swap = (snapshot: typeof base) => ({ ...snapshot, tools: ["read", "bash"] });
  const orderDiff = diffPrefixSnapshots(base, swap(base));
  assert.equal(orderDiff.toolsReordered, true);
  assert.match(orderDiff.summary, /工具顺序变化/);
});

test("token estimate ignores hash-only sections and grows with the prompt", () => {
  const small = buildPrefixSnapshot({ appendSystemPrompt: "x" }, ["read"]);
  const large = buildPrefixSnapshot({ appendSystemPrompt: "x".repeat(3_200) }, ["read"]);
  assert.ok(estimatePrefixTokens(large) > estimatePrefixTokens(small) + 500);
  const withFiles = buildPrefixSnapshot(
    { contextFiles: [{ path: "AGENTS.md", content: "y".repeat(10_000) }] },
    ["read"],
  );
  assert.equal(
    estimatePrefixTokens(withFiles),
    estimatePrefixTokens(buildPrefixSnapshot({}, ["read"])),
    "上下文文件只存指纹，不应虚增估算",
  );
});

test("user context block carries cwd with forward slashes only", () => {
  assert.equal(userContextBlock({ cwd: "D:\\Pi\\PiForge" }), "<context>cwd: D:/Pi/PiForge</context>");
  assert.equal(userContextBlock({ cwd: "   " }), null);
  assert.equal(userContextBlock({}), null);
});
