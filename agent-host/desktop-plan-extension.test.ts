import test from "node:test";
import assert from "node:assert/strict";
import {
  createDesktopPlanFactory,
  desktopPlanInlineExtension,
  PLAN_PROGRESS_GUIDELINES,
} from "./desktop-plan-extension.ts";

type Registered = {
  name: string;
  parameters: unknown;
  execute: (toolCallId: string, params: unknown) => Promise<{
    content: Array<{ type: string; text: string }>;
    details: Record<string, unknown>;
  }>;
};

function fakePi() {
  const tools: Registered[] = [];
  const guidelines: string[][] = [];
  return {
    tools,
    guidelines,
    pi: {
      registerTool: (tool: Registered) => {
        tools.push(tool);
      },
      on: (event: string, handler: (payload: never) => void) => {
        if (event !== "before_agent_start") return;
        const systemPromptOptions: { promptGuidelines?: string[] } = { promptGuidelines: [] };
        handler({ systemPromptOptions } as never);
        guidelines.push([...(systemPromptOptions.promptGuidelines ?? [])]);
      },
    },
  };
}

test("desktopPlanInlineExtension 暴露工厂与固定名字", () => {
  const ext = desktopPlanInlineExtension();
  assert.ok(typeof ext === "object" && ext !== null && "name" in ext);
  assert.equal(ext.name, "desktop-plan");
  assert.ok("factory" in ext);
  assert.equal(typeof ext.factory, "function");
});

test("默认注册 plan 工具并注入提示词", () => {
  const { tools, guidelines, pi } = fakePi();
  createDesktopPlanFactory()(pi as never);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["plan"],
  );
  assert.equal(guidelines.length, 1);
  assert.deepEqual([...guidelines[0]].sort(), [...PLAN_PROGRESS_GUIDELINES].sort());
});

test("设置项关闭时既不声明工具也不注入提示词", () => {
  const { tools, guidelines, pi } = fakePi();
  createDesktopPlanFactory({ enabled: () => false })(pi as never);
  assert.equal(tools.length, 0);
  assert.equal(guidelines.length, 0);
});

test("返回值只有 ok，不回显步骤（省 token）", async () => {
  const { tools, pi } = fakePi();
  createDesktopPlanFactory()(pi as never);
  const tool = tools[0];
  const created = await tool.execute("c1", {
    steps: [{ title: "读代码" }, { title: "改代码", status: "active" }],
  });
  assert.equal(created.content[0].text, "ok");
  const advanced = await tool.execute("c2", { update: { index: 1, status: "done" } });
  assert.equal(advanced.content[0].text, "ok");
});

test("两个参数都缺 / 非法时给出可执行的纠正提示", async () => {
  const { tools, pi } = fakePi();
  createDesktopPlanFactory()(pi as never);
  const tool = tools[0];
  const empty = await tool.execute("c1", {});
  assert.match(empty.content[0].text, /steps/);
  assert.equal(empty.details.error, "invalid_plan");
  const badUpdate = await tool.execute("c2", { update: { index: -1, status: "done" } });
  assert.equal(badUpdate.details.error, "invalid_plan");
});
