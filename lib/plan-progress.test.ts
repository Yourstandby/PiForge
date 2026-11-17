import test from "node:test";
import assert from "node:assert/strict";
import {
  applyPlanCall,
  PLAN_MAX_STEPS,
  planByRound,
  planFromMessages,
  planInRange,
  readPlanSteps,
  readPlanUpdate,
} from "./plan-progress.ts";

function assistantCall(input: unknown, toolName = "plan") {
  return {
    role: "assistant",
    content: [{ type: "toolCall", toolCallId: "c1", toolName, input }],
  };
}

assert.equal(PLAN_MAX_STEPS, 20);

test("没有 plan 调用 → null（卡片不渲染）", () => {
  assert.equal(planFromMessages([]), null);
  assert.equal(planFromMessages([{ role: "user", content: "hi" }]), null);
});

test("SDK 形状的 toolCall（name / arguments）同样能识别", () => {
  // 会话 JSONL 里存的是 {id, name, arguments}，不是 {toolCallId, toolName, input}。
  const progress = planFromMessages([
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_1",
          name: "plan",
          arguments: { steps: [{ title: "读代码", status: "done" }, { title: "改代码" }] },
        },
      ],
    },
  ]);
  assert.ok(progress, "真实会话形状必须能折叠出进度，否则卡片永远不渲染");
  assert.equal(progress.total, 2);
  assert.equal(progress.done, 1);
  assert.equal(progress.activeIndex, 1);
});

test("全量 steps 决定步数与完成数", () => {
  const progress = planFromMessages([
    assistantCall({ steps: [{ title: "读代码", status: "done" }, { title: "改代码" }, { title: "跑测试" }] }),
  ]);
  assert.ok(progress);
  assert.equal(progress.total, 3);
  assert.equal(progress.done, 1);
  assert.equal(progress.activeIndex, 1, "没有 active 时回落到第一个 pending");
  assert.deepEqual(
    progress.steps.map((step) => step.status),
    ["done", "pending", "pending"],
  );
});

test("增量 update 只改一步，不重传全量", () => {
  const created = applyPlanCall(null, { steps: [{ title: "a" }, { title: "b" }] });
  const advanced = applyPlanCall(created, { update: { index: 0, status: "done" } });
  assert.ok(advanced);
  assert.equal(advanced.done, 1);
  assert.equal(advanced.steps[1].title, "b", "增量不能丢掉其它步骤");
  const finished = applyPlanCall(advanced, { update: { index: 1, status: "done" } });
  assert.ok(finished);
  assert.equal(finished.done, 2);
  assert.equal(finished.activeIndex, -1, "全做完没有进行中的一步");
});

test("越界 / 非法 update 被忽略，不炸也不清零", () => {
  const created = applyPlanCall(null, { steps: [{ title: "a" }, { title: "b" }] });
  assert.deepEqual(applyPlanCall(created, { update: { index: 9, status: "done" } }), created);
  assert.deepEqual(applyPlanCall(created, { update: { index: 0, status: "nope" } }), created);
  assert.equal(readPlanUpdate({ index: 0, status: "nope" }), null);
  assert.equal(readPlanUpdate({ index: -1, status: "done" }), null);
});

test("非法 / 空 steps 不清空已有进度", () => {
  const created = applyPlanCall(null, { steps: [{ title: "a" }] });
  assert.equal(applyPlanCall(created, {}), created);
  assert.equal(applyPlanCall(created, { steps: [] }), created);
  assert.equal(readPlanSteps([]), null);
  assert.equal(readPlanSteps([{ title: "   " }]), null);
});

test("标题裁剪空白、超长截断；文本数组也算步骤", () => {
  const steps = readPlanSteps([
    "  第一 步  ",
    { title: "x".repeat(80) },
    { title: "y", status: "done" },
  ]);
  assert.ok(steps);
  assert.equal(steps[0].title, "第一 步");
  assert.equal(steps[1].title.length, 40);
  assert.equal(steps[2].status, "done");
});

test("步骤数封顶 20 步", () => {
  const steps = readPlanSteps(
    Array.from({ length: 40 }, (_, i) => ({ title: `s${i}` })),
  );
  assert.ok(steps);
  assert.equal(steps.length, PLAN_MAX_STEPS);
});

test("多次调用取累计结果（列计划 → 推进 → 改计划）", () => {
  const progress = planFromMessages([
    assistantCall({ steps: [{ title: "a" }, { title: "b" }] }),
    { role: "user", content: "继续" },
    assistantCall({ update: { index: 0, status: "done" } }),
    assistantCall({ steps: [{ title: "a", status: "done" }, { title: "c" }] }),
  ]);
  assert.ok(progress);
  assert.deepEqual(
    progress.steps.map((step) => step.title),
    ["a", "c"],
    "最后一次全量覆盖前一次",
  );
  assert.equal(progress.done, 1);
});

test("非 plan 工具调用被忽略", () => {
  assert.equal(planFromMessages([assistantCall({ steps: [{ title: "a" }] }, "bash")]), null);
});

test("codemode 脚本内的 plan 调用（nestedCalls）也能折叠出进度", () => {
  // 真实会话里模型把 plan 写进 codemode 脚本：顶层只有 codemode 一条 toolCall，
  // 嵌套调用只落在结果的 nestedCalls 上（含完整 arguments）。
  const progress = planFromMessages([
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          toolCallId: "c1",
          toolName: "codemode",
          input: { code: "const r = await tools.plan({ steps: [...] }); return r;" },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "codemode",
      content: [{ type: "text", text: "ok" }],
      nestedCalls: {
        complete: true,
        calls: [
          {
            id: "c1/1",
            name: "plan",
            status: "ok",
            arguments: { steps: [{ title: "读代码", status: "active" }, { title: "改代码" }] },
          },
        ],
      },
    },
  ]);
  assert.ok(progress, "嵌套 plan 调用必须能出卡片，否则卡片永远不渲染");
  assert.equal(progress.total, 2);
  assert.equal(progress.activeIndex, 0);
});

test("嵌套调用里的非 plan 工具被忽略", () => {
  assert.equal(
    planFromMessages([
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "codemode",
        content: [{ type: "text", text: "ok" }],
        nestedCalls: {
          complete: true,
          calls: [{ id: "c1/1", name: "bash", status: "ok", arguments: { command: "ls" } }],
        },
      },
    ]),
    null,
  );
});

test("嵌套全量 + 顶层 update 混用按消息顺序累加", () => {
  const progress = planFromMessages([
    {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "codemode",
      content: [{ type: "text", text: "ok" }],
      nestedCalls: {
        complete: true,
        calls: [
          { id: "c1/1", name: "plan", status: "ok", arguments: { steps: [{ title: "a" }, { title: "b" }] } },
        ],
      },
    },
    assistantCall({ update: { index: 0, status: "done" } }),
  ]);
  assert.ok(progress);
  assert.equal(progress.done, 1);
  assert.equal(progress.activeIndex, 1);
});
test("sinceLastUser：上一轮没结尾的计划不再被翻出来", () => {
  const messages = [
    { role: "user", content: "第一轮" },
    assistantCall({ steps: [{ title: "修复 env key", status: "active" }, { title: "跑测试", status: "done" }] }),
    { role: "user", content: "第二轮，跟计划无关" },
    { role: "assistant", content: [{ type: "text", text: "好的" }] },
  ];
  // 全量折叠：旧计划会一直挂着（这正是要修的现象）
  assert.ok(planFromMessages(messages));
  // 只看当前轮：本轮没有 plan 调用 → 没有卡片
  assert.equal(planFromMessages(messages, { sinceLastUser: true }), null);
});

test("sinceLastUser：同一轮里的 plan 调用照常折叠", () => {
  const messages = [
    { role: "user", content: "旧轮次" },
    assistantCall({ steps: [{ title: "旧步骤", status: "active" }] }),
    { role: "user", content: "新一轮" },
    assistantCall({ steps: [{ title: "读代码", status: "done" }, { title: "改代码" }] }),
  ];
  const progress = planFromMessages(messages, { sinceLastUser: true });
  assert.ok(progress);
  assert.deepEqual(progress.steps.map((step) => step.title), ["读代码", "改代码"]);
  assert.equal(progress.done, 1);
});

test("sinceLastUser：没有用户消息时等价全量折叠", () => {
  const messages = [assistantCall({ steps: [{ title: "只有助手消息" }] })];
  assert.deepEqual(planFromMessages(messages, { sinceLastUser: true }), planFromMessages(messages));
});

test("planInRange：只折叠区间内的调用（区间外的一律不算）", () => {
  const messages = [
    { role: "user", content: "第一轮" },
    assistantCall({ steps: [{ title: "旧步骤", status: "done" }] }),
    { role: "user", content: "第二轮" },
    assistantCall({ steps: [{ title: "新步骤" }] }),
  ];
  const second = planInRange(messages, 2, messages.length);
  assert.ok(second);
  assert.deepEqual(second.steps.map((step) => step.title), ["新步骤"]);
  // 空区间 / 越界区间：不报错，就是没有卡片
  assert.equal(planInRange(messages, 2, 2), null);
  assert.equal(planInRange(messages, 99, 120), null);
});

test("planByRound：每轮各自冻结一张卡片，钉在该轮最后一条轮次上", () => {
  const messages = [
    { role: "user", content: "第一轮" },
    assistantCall({ steps: [{ title: "a", status: "done" }, { title: "b", status: "done" }] }),
    assistantCall({ update: { index: 0, status: "done" } }),
    { role: "user", content: "第二轮" },
    assistantCall({ steps: [{ title: "c" }] }),
  ];
  const turns = [
    { role: "user" as const, messageIndex: 0 },
    { role: "assistant" as const, messageIndex: 1 },
    { role: "assistant" as const, messageIndex: 2 },
    { role: "user" as const, messageIndex: 3 },
    { role: "assistant" as const, messageIndex: 4 },
  ];
  const { plans, lastRoundStart } = planByRound(turns, messages);
  assert.equal(lastRoundStart, 3, "最后一轮的下标给调用方判断要不要在转录里重复渲染");
  assert.deepEqual([...plans.keys()], [2, 4], "键 = 该轮最后一条轮次的下标");
  assert.equal(plans.get(2)?.done, 2, "上一轮做完的 2/2 不会被下一轮改写");
  assert.equal(plans.get(2)?.total, 2);
  assert.equal(plans.get(4)?.done, 0);
  // 新一轮开跑（又多一条 user 消息）后，上一轮的卡片内容不变
  const laterMessages = [...messages, { role: "user", content: "第三轮" }];
  const later = planByRound(
    [...turns, { role: "user" as const, messageIndex: 5 }],
    laterMessages,
  );
  assert.deepEqual(later.plans.get(2), plans.get(2));
});

test("planByRound：没有 plan 调用的轮次不产生卡片", () => {
  const messages = [
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "text", text: "在的" }] },
  ];
  const { plans } = planByRound(
    [
      { role: "user" as const, messageIndex: 0 },
      { role: "assistant" as const, messageIndex: 1 },
    ],
    messages,
  );
  assert.equal(plans.size, 0);
});
