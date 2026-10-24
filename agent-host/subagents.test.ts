import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "./sdk-adapter.ts";
import type { SubagentLifecycleEvent } from "../contract/domains/subagents.ts";
import {
  SubagentError,
  listSubagents,
  onSubagentsChange,
  resetSubagentsForTest,
  spawnSubagent,
  stopAllSubagents,
  stopSubagent,
} from "./subagents.ts";
import { getSharedAuxRuntime, invalidateAuxRuntime } from "./aux-models.ts";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

function setupEnv() {
  const dir = mkdtempSync(join(tmpdir(), "pi-subagents-"));
  const previous = process.env[AGENT_DIR_ENV];
  process.env[AGENT_DIR_ENV] = join(dir, "agent");
  invalidateAuxRuntime();
  return {
    dir,
    cleanup: async () => {
      await stopAllSubagents();
      resetSubagentsForTest();
      invalidateAuxRuntime();
      if (previous === undefined) delete process.env[AGENT_DIR_ENV];
      else process.env[AGENT_DIR_ENV] = previous;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function registerFaux(providerId: string, texts: string[]) {
  const runtime = await getSharedAuxRuntime();
  const faux = fauxProvider({ provider: providerId, api: `${providerId}-api` });
  runtime.registerNativeProvider(faux.provider);
  faux.setResponses(texts.map((text) => fauxAssistantMessage(text)));
  return faux;
}

test("spawnSubagent runs an isolated child and returns its final answer", { timeout: 30000 }, async () => {
  const env = setupEnv();
  try {
    const faux = await registerFaux("subagent-fixture", ["sub-agent final report"]);
    const events: SubagentLifecycleEvent[] = [];
    const off = onSubagentsChange((event) => {
      if (event) events.push(event);
    });
    try {
      const result = await spawnSubagent({
        name: "researcher",
        task: "Inspect src/index.ts and summarise it.",
        cwd: env.dir,
        parentSessionId: "parent-session",
        model: faux.getModel(),
      });
      assert.equal(result.ok, true, result.error);
      assert.equal(result.agent.name, "researcher");
      assert.equal(result.agent.status, "completed");
      assert.match(result.text, /sub-agent final report/);
      assert.ok(result.agent.endedAt);
      assert.ok(result.agent.durationMs >= 0);
      // No test/build result in the report: the guardrail flags it, but the
      // sub-agent still completes (default is not to block).
      assert.equal(result.agent.verification?.verified, false);
      assert.match(result.agent.verification?.reason ?? "", /未找到/);
      assert.match(result.text, /UNVERIFIED/);

      assert.ok(events.some((event) => event.type === "subagent_started"));
      assert.ok(events.some((event) => event.type === "subagent_output"));
      const finished = events.find((event) => event.type === "subagent_finished");
      assert.ok(finished && finished.type === "subagent_finished");
      assert.equal(finished.agent.verification?.verified, false);

      const listed = listSubagents();
      const found = listed.find((agent) => agent.id === result.agent.id);
      assert.ok(found);
      assert.equal(found.status, "completed");
      assert.match(found.output, /sub-agent final report/);
    } finally {
      off();
    }
  } finally {
    await env.cleanup();
  }
});

test("spawnSubagent keeps text-only test claims unverified", { timeout: 30000 }, async () => {
  const env = setupEnv();
  try {
    const faux = await registerFaux("subagent-fixture-verified", [
      "Ran npm test: 5 passed, 0 failed.",
    ]);
    const result = await spawnSubagent({
      name: "verifier",
      task: "Check the test status.",
      cwd: env.dir,
      parentSessionId: "parent-session",
      model: faux.getModel(),
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.agent.verification?.verified, false);
    assert.match(result.agent.verification?.reason ?? "", /只有文本自述/);
    assert.match(result.text, /UNVERIFIED/);
  } finally {
    await env.cleanup();
  }
});

test("spawnSubagent validates inputs and the concurrency limit", { timeout: 30000 }, async () => {
  const env = setupEnv();
  try {
    const faux = await registerFaux("subagent-fixture-limit", [
      "one",
      "two",
      "three",
      "four",
    ]);
    await assert.rejects(
      () =>
        spawnSubagent({
          name: "",
          task: "x",
          cwd: env.dir,
          parentSessionId: "parent",
          model: faux.getModel(),
        }),
      (error: unknown) => error instanceof SubagentError && /name/i.test(error.message),
    );
    await assert.rejects(
      () =>
        spawnSubagent({
          name: "a",
          task: "",
          cwd: env.dir,
          parentSessionId: "parent",
          model: faux.getModel(),
        }),
      (error: unknown) => error instanceof SubagentError && /taskPrompt/i.test(error.message),
    );

    const firstFour = [1, 2, 3, 4].map((index) =>
      spawnSubagent({
        name: `agent-${index}`,
        task: `task ${index}`,
        cwd: env.dir,
        parentSessionId: "parent",
        model: faux.getModel(),
      }),
    );
    await assert.rejects(
      () =>
        spawnSubagent({
          name: "agent-5",
          task: "task 5",
          cwd: env.dir,
          parentSessionId: "parent",
          model: faux.getModel(),
        }),
      (error: unknown) => error instanceof SubagentError && /limit/i.test(error.message),
    );
    const results = await Promise.all(firstFour);
    assert.ok(results.every((result) => result.ok), results.map((result) => result.error).join("\n"));
  } finally {
    await env.cleanup();
  }
});

test("stopSubagent marks an unknown or finished child as not running", async () => {
  assert.equal(stopSubagent("does-not-exist"), false);
  assert.deepEqual(listSubagents(), []);
});

test("a spawned sub-agent is listed as running before it finishes (panel gets a card immediately)", { timeout: 30000 }, async () => {
  const env = setupEnv();
  try {
    const faux = await registerFaux("subagent-live-fixture", ["first child report", "second child report"]);
    // 先跑完一个，制造"旧任务"。
    const done = await spawnSubagent({
      name: "finished-first",
      task: "Summarise the README.",
      cwd: env.dir,
      parentSessionId: "parent-session",
      model: faux.getModel(),
    });
    assert.equal(done.ok, true, done.error);

    /** started 事件触发的那一刻，面板应该已经能拿到这张 running 卡片。 */
    let snapshotAtStart: { status: string; task: string; isFirst: boolean } | null = null;
    const off = onSubagentsChange((event) => {
      if (event?.type !== "subagent_started") return;
      const listed = listSubagents();
      const live = listed.find((agent) => agent.id === event.agent.id);
      snapshotAtStart = live
        ? { status: live.status, task: live.task, isFirst: listed[0]?.id === live.id }
        : null;
    });
    let spawnedId = "";
    try {
      const result = await spawnSubagent({
        name: "live-one",
        task: "Inspect src/index.ts and summarise it.",
        cwd: env.dir,
        parentSessionId: "parent-session",
        model: faux.getModel(),
      });
      spawnedId = result.agent.id;
      assert.equal(result.ok, true, result.error);
    } finally {
      off();
    }

    assert.ok(snapshotAtStart, "subagent_started 必须在子 Agent 跑完之前就广播");
    const seen = snapshotAtStart as unknown as { status: string; task: string; isFirst: boolean };
    assert.equal(seen.status, "running", "卡片出现时就是 running");
    assert.equal(seen.task, "Inspect src/index.ts and summarise it.", "卡片带 target prompt");
    assert.equal(seen.isFirst, true, "新拉起的子 Agent 必须排在最上面");

    // 跑完之后状态收敛到 completed。
    const finished = listSubagents().find((agent) => agent.id === spawnedId);
    assert.equal(finished?.status, "completed");
  } finally {
    await env.cleanup();
  }
});

/**
 * 三条退出路径的文案必须各不相同（主 Agent 靠它区分「缺上下文」和「死循环」）：
 *   1. 轮数上限 → need_help + 已用轮数 + 最后一次有效动作 + 换/拆建议；
 *   2. progress-guard → need_help + 空转话术（不能和轮数上限长一样）；
 *   3. 正常完成 → 摘要 + 验证行，不能出现 need_help。
 */
test("turn cap returns a need_help report naming turns and the last effective action", { timeout: 30000 }, async () => {
  const env = setupEnv();
  try {
    const { writeFileSync } = await import("node:fs");
    const target = join(env.dir, "note.txt");
    writeFileSync(target, "hello");
    const { fauxToolCall } = await import("@earendil-works/pi-ai");
    const faux = await registerFaux("subagent-turn-cap", []);
    faux.setResponses(
      Array.from({ length: 8 }, () => fauxAssistantMessage([fauxToolCall("read", { path: target })])),
    );
    const result = await spawnSubagent({
      name: "turn-capped",
      task: "Keep reading the same file until the valve stops you.",
      cwd: env.dir,
      parentSessionId: "parent-session",
      model: faux.getModel(),
      tools: ["read"],
      availableTools: ["read"],
    });
    assert.equal(result.ok, false, "轮数上限必须走 ok:false");
    assert.match(result.text, /status: need_help/);
    // off-by-one 已修：旧行为第 3 轮就被杀，新行为至少跑满 7 轮才拦（上限 6）。
    const used = Number(/turns: (\d+)\/6/.exec(result.text)?.[1] ?? "0");
    assert.ok(used >= 7, `应至少跑 7 轮才触发上限，实际 ${used} 轮（旧行为是 3）`);
    assert.match(result.text, /last_action: read/);
    assert.match(result.text, /herdr_spawn/);
    assert.match(result.text, /拆成 2–3 个更小的子任务/);
    assert.doesNotMatch(result.text, /was cancelled\./, "禁止再出现静默取消的空话");
  } finally {
    await env.cleanup();
  }
});

test("progress-guard report is distinguishable from the turn-cap report", { timeout: 30000 }, async () => {
  const env = setupEnv();
  try {
    const { fauxToolCall } = await import("@earendil-works/pi-ai");
    const faux = await registerFaux("subagent-progress", []);
    // tool_search 是「元动作」：不算进展，所以连续几轮就会被 progress-guard 停掉。
    faux.setResponses(
      Array.from({ length: 8 }, () => fauxAssistantMessage([fauxToolCall("tool_search", { query: "x" })])),
    );
    const result = await spawnSubagent({
      name: "spinner",
      task: "Spin on meta actions without touching any file.",
      cwd: env.dir,
      parentSessionId: "parent-session",
      model: faux.getModel(),
      tools: ["read"],
      availableTools: ["read"],
    });
    assert.equal(result.ok, false);
    assert.match(result.text, /status: need_help/);
    assert.match(result.text, /空转中断|无进展/);
    assert.match(result.text, /last_action: 无（从未调用过任何工具）/, "元动作不能被当成有效动作");
    assert.doesNotMatch(result.text, /轮数上限/, "空转必须先于轮数上限结算");
    assert.doesNotMatch(result.text, /拆成 2–3 个更小的子任务/, "文案不能和轮数上限路径相同");
  } finally {
    await env.cleanup();
  }
});

test("a completed sub-agent never reports need_help", { timeout: 30000 }, async () => {
  const env = setupEnv();
  try {
    const faux = await registerFaux("subagent-completed", ["all good: nothing to change"]);
    const result = await spawnSubagent({
      name: "finisher",
      task: "Answer with a short conclusion.",
      cwd: env.dir,
      parentSessionId: "parent-session",
      model: faux.getModel(),
    });
    assert.equal(result.ok, true);
    assert.match(result.text, /Sub-agent "finisher" completed\./);
    assert.match(result.text, /Verification: /);
    assert.doesNotMatch(result.text, /status: need_help/);
    assert.doesNotMatch(result.text, /轮数上限|空转中断/);
  } finally {
    await env.cleanup();
  }
});
