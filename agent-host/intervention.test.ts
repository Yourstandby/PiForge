import test from "node:test";
import assert from "node:assert/strict";
import {
  ASK_FALLBACK_STEP,
  BRIEF_ASK_INSTRUCTION,
  CONTINUE_AFTER_INTERVENTION,
  SKIP_INSTRUCTION,
  buildAskMessage,
  buildInterventionMessage,
  checkIntervention,
  isInterventionAction,
  resolveDelivery,
  shouldInterruptTool,
  INTERRUPT_TOOL_AFTER_MS,
  INTERVENE_COOLDOWN_MS,
  MAX_INTERVENTIONS_PER_TASK,
} from "./intervention.ts";

test("skip instruction keeps the task alive after skipping the stuck tool", () => {
  assert.equal(
    SKIP_INSTRUCTION,
    "[系统提示] 当前工具执行因无进展被系统强制跳过。请放弃这个卡住的工具，改用其他方式继续完成同一个目标，不要跳过任务本身。" +
      CONTINUE_AFTER_INTERVENTION,
  );
  assert.match(SKIP_INSTRUCTION, /不要跳过任务本身/);
  assert.equal(buildInterventionMessage("skip", "bash"), SKIP_INSTRUCTION);
});

test("every intervention tells the model to keep going after answering", () => {
  // 回归：介入文本曾被模型当成新提问，答完就结束本轮 → 原任务被“回答”顶掉。
  for (const action of ["skip", "ask", "ask_brief"] as const) {
    const message = buildInterventionMessage(action, "bash");
    assert.match(message, /继续执行原任务/);
    assert.match(message, /不要结束本轮/);
  }
});

test("brief ask forbids tool calls and caps the reply at one short sentence", () => {
  assert.equal(
    BRIEF_ASK_INSTRUCTION,
    "[系统提示] 看门狗发现当前工具已超时无输出，请勿执行任何新工具核实。请直接用一句话（20字以内）告诉我：你卡在哪个工具了，是否需要我帮你跳过？" +
      CONTINUE_AFTER_INTERVENTION,
  );
  // 三个关键约束缺一不可。
  assert.match(BRIEF_ASK_INSTRUCTION, /请勿执行任何新工具核实/);
  assert.match(BRIEF_ASK_INSTRUCTION, /一句话（20字以内）/);
  assert.match(BRIEF_ASK_INSTRUCTION, /是否需要我帮你跳过/);

  // 极简询问与上下文无关（不拼 lastSuccessAction），字数远低于深度诊断。
  assert.equal(buildInterventionMessage("ask_brief", "bash"), BRIEF_ASK_INSTRUCTION);
  assert.equal(buildInterventionMessage("ask_brief", null), BRIEF_ASK_INSTRUCTION);
  // 关键区别不是字数，而是是否允许模型自己跑工具核实：
  // 极简询问显式禁止，深度诊断则默许“分析原因” → 模型会去跑 tsc / grep。
  assert.equal(BRIEF_ASK_INSTRUCTION.includes("新工具"), true);
  assert.equal(buildInterventionMessage("ask", "bash").includes("新工具"), false);
  assert.equal(buildInterventionMessage("ask", "bash").includes("一句话"), false);

  // 深度诊断保留原有长提示词（允许模型去核实状态）。
  assert.equal(
    buildInterventionMessage("ask", "bash"),
    `你之前在 bash 之后似乎卡住了，请分析原因并给出新的执行方案。${CONTINUE_AFTER_INTERVENTION}`,
  );
});

test("ask message names the last successful action, falling back gracefully", () => {
  assert.equal(
    buildAskMessage("bash"),
    `你之前在 bash 之后似乎卡住了，请分析原因并给出新的执行方案。${CONTINUE_AFTER_INTERVENTION}`,
  );
  assert.equal(
    buildAskMessage(null),
    `你之前在 ${ASK_FALLBACK_STEP} 之后似乎卡住了，请分析原因并给出新的执行方案。${CONTINUE_AFTER_INTERVENTION}`,
  );
  assert.equal(buildAskMessage("   ").includes(ASK_FALLBACK_STEP), true);
});

test("delivery prefers steer, then the front of the queue, then a fresh prompt", () => {
  assert.equal(resolveDelivery({ streaming: true, queued: 0 }), "steer");
  assert.equal(resolveDelivery({ streaming: true, queued: 3 }), "steer");
  assert.equal(resolveDelivery({ streaming: false, queued: 2 }), "queue");
  assert.equal(resolveDelivery({ streaming: false, queued: 0 }), "prompt");
});

test("guard refuses intervention when there is no active task", () => {
  const base = {
    actionType: "skip" as const,
    now: 1_000,
    lastInterventionAt: null,
    lastInterventionAction: null,
    interventions: 0,
  };
  assert.equal(checkIntervention({ ...base, taskStatus: null }).reason, "no_active_task");
  assert.equal(checkIntervention({ ...base, taskStatus: "completed" }).reason, "no_active_task");
  assert.equal(checkIntervention({ ...base, taskStatus: "failed" }).reason, "no_active_task");
  assert.equal(checkIntervention({ ...base, taskStatus: "running" }).allowed, true);
  assert.equal(checkIntervention({ ...base, taskStatus: "stalled" }).allowed, true);
});

test("guard blocks a repeated click inside the cooldown but allows it afterwards", () => {
  const base = {
    actionType: "skip" as const,
    taskStatus: "stalled" as const,
    interventions: 1,
  };
  const duplicate = checkIntervention({
    ...base,
    now: 10_000 + INTERVENE_COOLDOWN_MS - 1,
    lastInterventionAt: 10_000,
    lastInterventionAction: "skip",
  });
  assert.equal(duplicate.allowed, false);
  assert.equal(duplicate.reason, "duplicate");

  const later = checkIntervention({
    ...base,
    now: 10_000 + INTERVENE_COOLDOWN_MS,
    lastInterventionAt: 10_000,
    lastInterventionAction: "skip",
  });
  assert.equal(later.allowed, true);

  // 另一种动作不受前一种的冷却限制。
  const otherAction = checkIntervention({
    ...base,
    actionType: "ask",
    now: 10_000 + 10,
    lastInterventionAt: 10_000,
    lastInterventionAction: "skip",
  });
  assert.equal(otherAction.allowed, true);
});

test("guard caps interventions per task", () => {
  const result = checkIntervention({
    actionType: "ask",
    taskStatus: "stalled",
    now: 1,
    lastInterventionAt: null,
    lastInterventionAction: null,
    interventions: MAX_INTERVENTIONS_PER_TASK,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "too_many");
});

test("only skip interrupts a tool, and only once it has run past the threshold", () => {
  const long = [{ runningSeconds: INTERRUPT_TOOL_AFTER_MS / 1000 + 1 }];
  const short = [{ runningSeconds: 1 }];
  assert.equal(shouldInterruptTool("skip", long), true);
  assert.equal(shouldInterruptTool("skip", short), false, "短命令打断只会白丢结果");
  assert.equal(shouldInterruptTool("ask", long), false, "询问不打断，只在 turn 边界插话");
  assert.equal(shouldInterruptTool("ask_brief", long), false);
  assert.equal(shouldInterruptTool("skip", []), false);
  assert.equal(shouldInterruptTool("skip", null), false);
});

test("actionType validation only accepts skip / ask / ask_brief", () => {
  assert.equal(isInterventionAction("skip"), true);
  assert.equal(isInterventionAction("ask"), true);
  assert.equal(isInterventionAction("ask_brief"), true);
  assert.equal(isInterventionAction("abort"), false);
  assert.equal(isInterventionAction(undefined), false);
  assert.equal(isInterventionAction(1), false);
});
