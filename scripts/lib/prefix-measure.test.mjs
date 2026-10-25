import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeRequest,
  buildReport,
  canonicalJson,
  compareReports,
  diffSystemPrompts,
  estimateTokens,
  formatSummaryLines,
  hasTools,
  summarizeCache,
  summarizeReport,
} from "./prefix-measure.mjs";

const CORE = { type: "function", function: { name: "read", description: "Read file contents", parameters: {} } };
const EXT = {
  type: "function",
  function: { name: "browser_read", description: "Read text or screenshot the built-in browser", parameters: {} },
};

function body(system, tools, userText) {
  return {
    model: "measure-1",
    messages: [
      { role: "system", content: system },
      { role: "user", content: userText },
    ],
    tools,
  };
}

test("estimateTokens counts CJK as one token and other text as four chars per token", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("中文"), 2);
  assert.equal(estimateTokens("abcdefgh中文"), 4);
});

test("canonicalJson is key-order independent so prefix hashes stay stable", () => {
  assert.equal(canonicalJson({ a: 1, b: [{ c: 2, d: 3 }] }), canonicalJson({ b: [{ d: 3, c: 2 }], a: 1 }));
});

test("analyzeRequest splits system prompt, tools and core/extra tool cost", () => {
  const analysis = analyzeRequest({
    path: "/v1/chat/completions",
    bytes: 100,
    body: body("you are pi", [CORE, EXT], "hi"),
  });
  assert.equal(analysis.messages, 2);
  assert.deepEqual(analysis.messageRoles, ["system", "user"]);
  assert.equal(analysis.systemTokens, estimateTokens("you are pi"));
  assert.equal(analysis.toolsCount, 2);
  assert.equal(analysis.coreToolsTokens, estimateTokens(canonicalJson(CORE)));
  assert.equal(analysis.extensionToolsTokens, estimateTokens(canonicalJson(EXT)));
  assert.equal(
    analysis.prefixTokens,
    analysis.systemTokens + analysis.toolsTokens,
    "prefix = system + tools"
  );
});

test("tool order is part of the prefix: reordering invalidates the cache", () => {
  // 提供方按序列化字节比对，数组顺序变化就是不同的前缀 —— 度量必须如实反映。
  const a = analyzeRequest({ body: body("s", [CORE, EXT], "hi") });
  const b = analyzeRequest({ body: body("s", [EXT, CORE], "hi") });
  assert.notEqual(a.prefixHash, b.prefixHash);
});

test("a changed tool schema changes the prefix hash", () => {
  const a = analyzeRequest({ body: body("s", [CORE], "hi") });
  const b = analyzeRequest({ body: body("s", [{ ...CORE, function: { ...CORE.function, description: "other" } }], "hi") });
  assert.notEqual(a.prefixHash, b.prefixHash);
});

test("hasTools ignores title/aux requests that carry no tools", () => {
  assert.equal(hasTools({ messages: [] }), false);
  assert.equal(hasTools({ tools: [] }), false);
  assert.equal(hasTools({ tools: [CORE] }), true);
});

test("buildReport flags a prefix change between turns and prices the invalidation", () => {
  const first = analyzeRequest({ body: body("s", [CORE], "hi") });
  const second = analyzeRequest({ body: body("s2", [CORE], "hi") });
  const report = buildReport("PiForge", [first, second]);
  assert.equal(report.prefixChangedBetweenTurns, true);
  assert.equal(report.invalidatedOnPrefixChange, first.bodyTokens);
  const stable = buildReport("PiForge", [first, analyzeRequest({ body: body("s", [CORE], "yo") })]);
  assert.equal(stable.prefixChangedBetweenTurns, false);
  assert.equal(stable.invalidatedOnPrefixChange, 0);
});

test("diffSystemPrompts attributes extra lines to their section", () => {
  const base = ["intro", "## guidelines", "- keep a", "- keep b"].join("\n");
  const next = [
    "intro",
    "## guidelines",
    "- keep a",
    "- keep b",
    "- added rule that is quite long indeed",
    "## tools",
    "- browser_read: Read the browser",
  ].join("\n");
  const sections = diffSystemPrompts(base, next);
  const guidelines = sections.find((section) => section.section === "guidelines");
  const tools = sections.find((section) => section.section === "tools");
  assert.ok(guidelines, "guidelines section must appear");
  assert.equal(guidelines.tokens, estimateTokens("- added rule that is quite long indeed"));
  assert.ok(tools, "tools section must appear");
});

test("diffSystemPrompts uses multiset semantics for repeated lines", () => {
  const base = ["- same line", "- same line"].join("\n");
  const next = ["- same line", "- same line"].join("\n");
  assert.equal(diffSystemPrompts(base, next).length, 0, "equal multisets add nothing");
  const extra = ["- same line", "- same line", "- same line"].join("\n");
  assert.equal(
    diffSystemPrompts(base, extra).reduce((sum, section) => sum + section.tokens, 0),
    estimateTokens("- same line"),
    "only the surplus copy counts as new"
  );
});

test("compareReports reports the PiForge-vs-pi delta", () => {
  const base = buildReport("pi CLI", [analyzeRequest({ body: body("s", [CORE], "hi") })]);
  const next = buildReport("PiForge", [analyzeRequest({ body: body("s", [CORE, EXT], "hi") })]);
  const log = console.log;
  console.log = () => {};
  try {
    const delta = compareReports(base, next);
    assert.equal(delta.extraToolsTokens, estimateTokens(canonicalJson(EXT)));
    assert.equal(delta.extraPrefixTokens, delta.extraSystemTokens + delta.extraToolsTokens);
    assert.match(delta.prefixDelta, /%$/);
  } finally {
    console.log = log;
  }
});

function report(label, overrides = {}) {
  return {
    label,
    turns: [
      {
        systemTokens: 3000,
        toolsTokens: 1200,
        toolsCount: 21,
        prefixTokens: 4200,
        bodyTokens: 4500,
        ...overrides,
      },
    ],
    prefixChangedBetweenTurns: false,
  };
}

test("summary keeps only the numbers a decision needs", () => {
  const summary = summarizeReport(report("PiForge"));
  assert.deepEqual(summary, {
    label: "PiForge",
    turns: 1,
    systemTokens: 3000,
    toolsTokens: 1200,
    toolsCount: 21,
    prefixTokens: 4200,
    bodyTokens: 4500,
    prefixChangedBetweenTurns: false,
  });
});

test("summary lines stay short and name the delta between the two runtimes", () => {
  const lines = formatSummaryLines({
    PiForge: report("PiForge"),
    "pi CLI": report("pi CLI", { toolsTokens: 0, toolsCount: 0, prefixTokens: 3300 }),
  });
  const text = lines.join(String.fromCharCode(10));
  assert.match(text, /PiForge +turns=1 sys=3000t tools=1200t\(21\) prefix=4200t/);
  assert.match(text, /差值\(PiForge-piCLI\): sys \+0t tools \+1200t prefix \+900t/);
  // 摘要是给人扫一眼的：整段不超过 10 行。
  assert.ok(lines.length <= 10, `too many lines: ${lines.length}`);
});

test("cache summary reports the hit rate over all tokens seen", () => {
  const cache = summarizeCache([
    { cache: { kind: "fg", totalTokens: 1_000, cacheReadTokens: 0, cacheCreationTokens: 1_000 } },
    { cache: { kind: "fg", totalTokens: 1_000, cacheReadTokens: 900, cacheCreationTokens: 0 } },
    { body: {} },
  ]);
  assert.equal(cache.requests, 2);
  assert.equal(cache.create, 1_000);
  assert.equal(cache.read, 900);
  assert.equal(cache.input, 100);
  assert.equal(cache.hitRate.toFixed(3), "0.450");
});

test("a prefix change is visible in the summary without reading the full report", () => {
  const changed = report("PiForge");
  changed.prefixChangedBetweenTurns = true;
  assert.match(formatSummaryLines({ PiForge: changed }).join(String.fromCharCode(10)), /前缀有变化/);
  assert.match(formatSummaryLines({ PiForge: report("PiForge") }).join(String.fromCharCode(10)), /前缀稳定/);
});
