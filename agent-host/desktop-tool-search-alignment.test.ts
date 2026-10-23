import assert from "node:assert/strict";
import test from "node:test";
import {
  TOOL_SEARCH_NEXT_TURN_CONSTRAINT,
  alignToolSearchResult,
  desktopToolSearchAlignmentInlineExtension,
} from "./desktop-tool-search-alignment.ts";
import { DOMAIN_LEGACY_TOOLS } from "../lib/domain-tools.ts";

const descriptions = {
  shell: "Shell: run | read | wait | exec.\nShell + managed background processes.",
  memory: "Memory: recall | save | forget.\nProject long-term memory.",
  run_bg: "Start a background process",
};

const isLegacy = (name: string) => DOMAIN_LEGACY_TOOLS.has(name);

test("alignToolSearchResult drops internal names and keeps wire names", () => {
  const aligned = alignToolSearchResult({
    loaded: ["run_bg", "shell", "powershell"],
    descriptions,
    isLegacy,
  });
  assert.deepEqual(aligned.wireNames, ["shell"]);
  assert.deepEqual(aligned.droppedLegacyNames, ["run_bg", "powershell"]);
  assert.match(aligned.text, /^- shell: Shell: run \| read \| wait \| exec\./m);
  assert.doesNotMatch(aligned.text, /run_bg|powershell/, "internal names must never leak");
  assert.ok(aligned.text.includes(TOOL_SEARCH_NEXT_TURN_CONSTRAINT));
});

test("names in the result are byte-identical to the registry names (no prettifying)", () => {
  const aligned = alignToolSearchResult({
    loaded: ["memory"],
    descriptions,
    isLegacy,
  });
  assert.deepEqual(aligned.wireNames, ["memory"]);
  assert.match(aligned.text, /^- memory: Memory: recall \| save \| forget\.$/m);
});

test("a query that only matched internal names says so without listing them", () => {
  const aligned = alignToolSearchResult({
    loaded: ["run_bg"],
    descriptions,
    isLegacy,
  });
  assert.deepEqual(aligned.wireNames, []);
  assert.match(aligned.text, /No loadable tool/);
  assert.doesNotMatch(aligned.text, /run_bg/);
});

test("duplicates in the loaded list collapse", () => {
  const aligned = alignToolSearchResult({
    loaded: ["shell", "shell", "memory"],
    descriptions,
    isLegacy,
  });
  assert.deepEqual(aligned.wireNames, ["shell", "memory"]);
});

test("the extension rewrites the result text and un-activates internal names", () => {
  const handlers: Array<(event: unknown) => unknown> = [];
  let active = ["read", "bash", "shell", "run_bg", "powershell"];
  const pi = {
    on: (name: string, handler: (event: unknown) => unknown) => {
      if (name === "tool_result") handlers.push(handler);
      return () => {};
    },
    getAllTools: () => [
      { name: "shell", description: descriptions.shell },
      { name: "run_bg", description: descriptions.run_bg },
    ],
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      active = [...names];
    },
  };
  (desktopToolSearchAlignmentInlineExtension() as { factory: (pi: unknown) => void }).factory(pi);

  const result = handlers[0]({
    type: "tool_result",
    toolCallId: "c1",
    toolName: "tool_search",
    input: { query: "shell" },
    isError: false,
    content: [{ type: "text", text: "Loaded 2 tools..." }],
    details: { loaded: ["run_bg", "shell"] },
  }) as { content: Array<{ text: string }>; details: { loaded: string[] } };

  assert.match(result.content[0].text, /^- shell:/m);
  assert.doesNotMatch(result.content[0].text, /run_bg/);
  assert.deepEqual(result.details.loaded, ["shell"]);
  assert.ok(!active.includes("run_bg"), "internal names are un-activated");
  assert.ok(!active.includes("powershell"));
  assert.ok(active.includes("shell"), "wire name stays active");
});

test("error results and unrelated tools are left untouched", () => {
  const handlers: Array<(event: unknown) => unknown> = [];
  const pi = {
    on: (name: string, handler: (event: unknown) => unknown) => {
      if (name === "tool_result") handlers.push(handler);
      return () => {};
    },
    getAllTools: () => [],
    getActiveTools: () => [],
    setActiveTools: () => {},
  };
  (desktopToolSearchAlignmentInlineExtension() as { factory: (pi: unknown) => void }).factory(pi);
  assert.equal(
    handlers[0]({
      type: "tool_result",
      toolCallId: "c1",
      toolName: "read",
      input: {},
      isError: false,
      content: [{ type: "text", text: "file" }],
      details: {},
    }),
    undefined
  );
  assert.equal(
    handlers[0]({
      type: "tool_result",
      toolCallId: "c2",
      toolName: "tool_search",
      input: {},
      isError: true,
      content: [{ type: "text", text: "boom" }],
      details: {},
    }),
    undefined
  );
});
