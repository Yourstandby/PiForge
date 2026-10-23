import test from "node:test";
import assert from "node:assert/strict";
import {
  STUB_CATALOG_MAX_CHARS,
  STUB_DESCRIPTION_MAX,
  TOOL_STUB_THRESHOLD,
  TOOL_USE_TOOL_NAME,
  buildToolStubs,
  selectDeclaredTools,
  shouldUseToolStubs,
  stubSummary,
  toolStubPromptSection,
} from "./tool-stubs.ts";

test("stub mode turns on above the threshold only", () => {
  assert.equal(TOOL_STUB_THRESHOLD, 5);
  assert.equal(shouldUseToolStubs(5), false);
  assert.equal(shouldUseToolStubs(6), true);
});

test("stub summaries are single-line, trimmed and capped", () => {
  assert.equal(stubSummary("  Use this tool to locate   the config\nfile "), "locate the config file");
  assert.equal(stubSummary(undefined), "");
  const long = stubSummary("x".repeat(STUB_DESCRIPTION_MAX + 20));
  assert.equal(Array.from(long).length, STUB_DESCRIPTION_MAX + 1);
  assert.ok(long.endsWith("…"));
});

test("stub catalog is sorted and capped by the character budget", () => {
  const catalog = buildToolStubs([
    { name: "zeta", description: "Z tool" },
    { name: "alpha", description: "A tool" },
    { name: "MCP__Beta", description: "B tool" },
  ]);
  assert.deepEqual(catalog.stubs.map((stub) => stub.name), ["MCP__Beta", "alpha", "zeta"]);
  assert.equal(catalog.omitted, 0);

  const many = Array.from({ length: 200 }, (_, index) => ({
    name: `tool_${String(index).padStart(3, "0")}`,
    description: "d".repeat(80),
  }));
  const capped = buildToolStubs(many, 400);
  assert.ok(capped.stubs.length > 0);
  assert.ok(capped.stubs.length < many.length);
  assert.equal(capped.omitted, many.length - capped.stubs.length);
  const section = toolStubPromptSection(capped);
  assert.ok(section.length < 400 + 400, "目录文本不能远超预算");
  assert.match(section, /还有 \d+ 个工具未列出，请用 tool_search 检索/);
  assert.ok(STUB_CATALOG_MAX_CHARS >= 1_000);
});

test("stub catalog prompt explains how to activate a tool", () => {
  const section = toolStubPromptSection(
    buildToolStubs([{ name: "browser_read", description: "Read the built-in browser page" }]),
  );
  assert.match(section, /\[未加载的工具\]/);
  assert.match(section, /tool_search/);
  assert.match(section, /desktop_use_tool/);
  assert.match(section, /- browser_read: Read the built-in browser page/);
});

test("stub catalog is empty when there is nothing to stub", () => {
  assert.equal(toolStubPromptSection({ stubs: [], omitted: 0 }), "");
});

test("without pinned tools everything is declared (no dead ends)", () => {
  const selection = selectDeclaredTools({
    coreTools: ["bash", "read"],
    extensionTools: ["mcp__a", "mcp__b", "mcp__c", "mcp__d", "mcp__e", "mcp__f"],
    activeExtensionTools: [],
    usedExtensionTools: [],
    pinnedTools: [],
  });
  assert.equal(selection.stubsActive, false, "没有常驻工具时不许存根");
  assert.deepEqual(selection.declared, [
    "bash",
    "read",
    "mcp__a",
    "mcp__b",
    "mcp__c",
    "mcp__d",
    "mcp__e",
    "mcp__f",
  ]);
  assert.deepEqual(selection.stubbed, []);
});

test("only requested extension tools are declared in stub mode", () => {
  const selection = selectDeclaredTools({
    coreTools: ["bash", "read"],
    extensionTools: ["mcp__a", "mcp__b", "mcp__c", "mcp__d", "mcp__e", "mcp__f"],
    activeExtensionTools: ["mcp__f"],
    usedExtensionTools: ["mcp__b"],
    pinnedTools: ["tool_search", TOOL_USE_TOOL_NAME],
  });
  assert.equal(selection.stubsActive, true);
  assert.deepEqual(selection.declared, [
    "bash",
    "read",
    "mcp__b",
    "mcp__f",
    "tool_search",
    TOOL_USE_TOOL_NAME,
  ]);
  assert.deepEqual(selection.stubbed, ["mcp__a", "mcp__c", "mcp__d", "mcp__e"]);
});

test("small extension sets keep the old full declaration", () => {
  const selection = selectDeclaredTools({
    coreTools: ["bash", "read"],
    extensionTools: ["mcp__a", "mcp__b"],
    activeExtensionTools: [],
    usedExtensionTools: [],
    pinnedTools: ["tool_search", TOOL_USE_TOOL_NAME],
  });
  assert.equal(selection.stubsActive, false);
  // 常驻工具必须一起声明：以前这里漏拼 pinnedTools，多态工具会凭空消失。
  assert.deepEqual(selection.declared, ["bash", "read", "mcp__a", "mcp__b", "tool_search", TOOL_USE_TOOL_NAME]);
});
