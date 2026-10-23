import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createDesktopLtmFactory,
  desktopLtmInlineExtension,
  MEMORY_TOOL_NAMES,
} from "./desktop-ltm-extension.ts";
import { resetMemoryServiceForTests } from "./ltm/service.ts";
import { PLAN_TOOLS } from "../lib/approval-policy.ts";

test("MEMORY_TOOL_NAMES lists save/recall/forget", () => {
  assert.deepEqual([...MEMORY_TOOL_NAMES].sort(), [
    "memory_forget",
    "memory_recall",
    "memory_save",
  ]);
});

test("memory is discovered through tool_search in ask/full mode", () => {
  // 声明集合由 desktop-runtime-tools 决定（见 on-demand-domains.test.ts）；
  // memory 只有在 plan 模式下通过 PLAN_TOOLS 显式带上只读 recall。
  assert.ok(PLAN_TOOLS.includes("memory"));
});

test("plan mode gating for memory lives in policy, not in the declaration helper", () => {
  assert.ok(PLAN_TOOLS.includes("memory"));
  assert.ok(!PLAN_TOOLS.includes("memory_save"));
});



test("desktopLtmInlineExtension factory registers three tool names", () => {
  const registered: string[] = [];
  const ext = desktopLtmInlineExtension({ getCwd: () => "/tmp/proj" });
  assert.ok(typeof ext === "object" && ext !== null && "name" in ext);
  assert.equal(ext.name, "desktop-ltm");
  assert.equal(typeof ext.factory, "function");

  const factory = createDesktopLtmFactory({ getCwd: () => "/tmp/proj" });
  factory({
    registerTool: (tool: { name: string }) => {
      registered.push(tool.name);
    },
  } as never);

  assert.deepEqual(registered.sort(), [...MEMORY_TOOL_NAMES].sort());
});

test("memory tools return disabled text when LTM is off", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "ltm-ext-"));
  try {
    writeFileSync(
      join(agentDir, "desktop-settings.json"),
      JSON.stringify({ ltm: { enabled: false } }),
      "utf-8"
    );
    resetMemoryServiceForTests();

    type ExecTool = {
      name: string;
      execute: (
        id: string,
        params: Record<string, unknown>
      ) => Promise<{ content: Array<{ type: string; text: string }> }>;
    };
    const tools = new Map<string, ExecTool>();
    createDesktopLtmFactory({
      getCwd: () => join(agentDir, "proj"),
      agentDir,
    })({
      registerTool: (tool: ExecTool) => {
        tools.set(tool.name, tool);
      },
    } as never);

    const save = await tools.get("memory_save")!.execute("t1", {
      content: "x",
    });
    assert.equal(save.content[0]?.text, "Long-term memory is disabled");

    const recall = await tools.get("memory_recall")!.execute("t2", {
      query: "x",
    });
    assert.equal(recall.content[0]?.text, "Long-term memory is disabled");

    const forget = await tools.get("memory_forget")!.execute("t3", {
      memoryIds: ["m1"],
    });
    assert.equal(forget.content[0]?.text, "Long-term memory is disabled");
  } finally {
    resetMemoryServiceForTests();
    rmSync(agentDir, { recursive: true, force: true });
  }
});
