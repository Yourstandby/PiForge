import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "./sdk-adapter.ts";
import {
  assertHerdrMessageAllowed,
  getHerdrAgent,
  listHerdrAgents,
  onHerdrChange,
  resetHerdrForTest,
  sendHerdrMessage,
  spawnHerdrAgent,
  stopAllHerdrAgents,
  stopHerdrAgent,
  shouldSleepIdle,
  sweepIdleHerdrAgents,
  wakeFleetAgent,
} from "./herdr-manager.ts";
import { getSharedAuxRuntime, invalidateAuxRuntime } from "./aux-models.ts";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

function setupEnv() {
  const dir = mkdtempSync(join(tmpdir(), "pi-herdr-"));
  const previous = process.env[AGENT_DIR_ENV];
  process.env[AGENT_DIR_ENV] = join(dir, "agent");
  invalidateAuxRuntime();
  return {
    dir,
    cleanup: async () => {
      await stopAllHerdrAgents();
      resetHerdrForTest();
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

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test("a one-shot fleet task exits as soon as it finishes (no background idling)", { timeout: 30000 }, async () => {
  const env = setupEnv();
  try {
    const faux = await registerFaux("herdr-fixture", ["initial report"]);
    const spawned = spawnHerdrAgent({
      name: "scout",
      task: "Inspect src/index.ts.",
      cwd: env.dir,
      parentSessionId: "parent",
      model: faux.getModel(),
    });
    assert.equal(spawned.status, "starting");
    assert.ok(spawned.id.startsWith("herdr-"));

    await waitFor(() => getHerdrAgent(spawned.id)?.status === "exited", "fleet agent exited");

    const done = getHerdrAgent(spawned.id)!;
    assert.equal(done.turns, 1);
    assert.equal(done.activity, "idle");
    assert.ok(done.endedAt, "退出必须带结束时间");
    assert.equal(done.output.includes("initial report"), true);
    assert.equal(done.verification.verified, false);
    assert.match(done.verification.reason, /未找到/);
    await assert.rejects(() => sendHerdrMessage(spawned.id, "more"), /exited/);
  } finally {
    await env.cleanup();
  }
});

test("Herdr message keeps context and applies the verification guardrail", { timeout: 30000 }, async () => {
  const env = setupEnv();
  try {
    const faux = await registerFaux("herdr-fixture-message", [
      "initial report",
      "Ran npm test: 5 passed, 0 failed.",
    ]);
    const spawned = spawnHerdrAgent({
      name: "verifier",
      task: "Check the test status.",
      cwd: env.dir,
      parentSessionId: "parent",
      model: faux.getModel(),
      idle: true,
    });
    await waitForStatus(spawned.id, (status) => status === "running", 5_000);

    const result = await sendHerdrMessage(spawned.id, "Run the test suite and report.");
    assert.equal(result.ok, true, result.error);
    assert.equal(result.agent.turns, 1);
    assert.equal(result.agent.verification.verified, false);
    assert.match(result.agent.verification.reason, /未找到测试执行证据|只有文本自述/);
  } finally {
    await env.cleanup();
  }
});

test("Herdr rejects messages in stopping or terminal states", () => {
  assert.throws(() => assertHerdrMessageAllowed("stopping"), /stopping/);
  assert.throws(() => assertHerdrMessageAllowed("stopped"), /stopped/);
  assert.throws(() => assertHerdrMessageAllowed("crashed"), /crashed/);
  assert.doesNotThrow(() => assertHerdrMessageAllowed("running"));
});

test("Herdr stop follows stopping → stopped and cannot be stopped twice", { timeout: 30000 }, async () => {
  const env = setupEnv();
  try {
    const faux = await registerFaux("herdr-fixture-stop", ["report"]);
    const spawned = spawnHerdrAgent({
      name: "stopper",
      task: "Inspect the repo.",
      cwd: env.dir,
      parentSessionId: "parent",
      model: faux.getModel(),
      idle: true,
    });
    await waitForStatus(spawned.id, (status) => status === "running", 5_000);
    assert.equal(await stopHerdrAgent(spawned.id), true);
    const stopped = getHerdrAgent(spawned.id)!;
    assert.equal(stopped.status, "stopped");
    assert.ok(stopped.endedAt);
    assert.equal(await stopHerdrAgent(spawned.id), false);
    assert.equal(listHerdrAgents().find((agent) => agent.id === spawned.id)?.status, "stopped");
  } finally {
    await env.cleanup();
  }
});

test("Herdr enforces the fleet limit", { timeout: 30000 }, async () => {
  const env = setupEnv();
  try {
    const faux = await registerFaux("herdr-fixture-limit", ["one", "two", "three", "four", "five"]);
    const spawned = [1, 2, 3, 4].map((index) =>
      spawnHerdrAgent({
        name: `agent-${index}`,
        task: `task ${index}`,
        cwd: env.dir,
        parentSessionId: "parent",
        model: faux.getModel(),
      }),
    );
    assert.equal(spawned.length, 4);
    assert.throws(
      () =>
        spawnHerdrAgent({
          name: "agent-5",
          task: "task 5",
          cwd: env.dir,
          parentSessionId: "parent",
          model: faux.getModel(),
        }),
      /Fleet is full/,
    );
  } finally {
    await env.cleanup();
  }
});

test("a fleet agent has no hard turn cap (only progress-guard brakes it)", { timeout: 30000 }, async () => {
  const env = setupEnv();
  try {
    const faux = await registerFaux("herdr-turns-fixture", ["r1", "r2", "r3", "r4"]);
    const agent = spawnHerdrAgent({
      name: "turn-uncapped",
      task: "first task",
      cwd: env.dir,
      parentSessionId: "parent",
      model: faux.getModel(),
      idle: true,
    });
    await waitForStatus(agent.id, (status) => status === "running", 5_000);
    const first = await sendHerdrMessage(agent.id, "first");
    assert.match(first.text, /r1/);
    const second = await sendHerdrMessage(agent.id, "second");
    assert.match(second.text, /r2/);
    const third = await sendHerdrMessage(agent.id, "third");
    assert.match(third.text, /r3/);
    const fourth = await sendHerdrMessage(agent.id, "fourth");
    assert.match(fourth.text, /r4/);
    /**
     * 一次性子 Agent 的轮数上限（默认 6）**不适用于**常驻舰队：
     * 它本来就是"接着聊"的形态，刹车只剩 progress-guard。
     */
    for (const label of ["fifth", "sixth"]) {
      const res = await sendHerdrMessage(agent.id, label);
      assert.doesNotMatch(res.text, /轮数上限/);
    }
    assert.ok((getHerdrAgent(agent.id)?.turns ?? 0) >= 6, "超过 5 轮也必须能继续派话");
  } finally {
    await env.cleanup();
  }
});

test("a woken fleet profile builds a session without burning a first turn", { timeout: 30000 }, async () => {
  const env = setupEnv();
  try {
    const faux = await registerFaux("herdr-wake-fixture", ["answer after wake"]);
    const agent = wakeFleetAgent({
      name: "woken-profile",
      cwd: env.dir,
      parentSessionId: "desktop",
      systemPrompt: "You are an auditor.",
      tools: ["read", "grep"],
      model: faux.getModel(),
    });
    assert.equal(agent.name, "woken-profile");
    const live = await waitForStatus(agent.id, (status) => status === "running", 5_000);
    assert.equal(live.status, "running");
    assert.equal(live.turns, 0, "唤醒不跑首轮");

    const reply = await sendHerdrMessage(agent.id, "look at src/index.ts");
    assert.match(reply.text, /answer after wake/);
    assert.equal(getHerdrAgent(agent.id)?.turns, 1);
  } finally {
    await env.cleanup();
  }
});

test("fleet changes are broadcast so the panel can update without polling", { timeout: 30000 }, async () => {
  const env = setupEnv();
  try {
    const faux = await registerFaux("herdr-events-fixture", ["done"]);
    const seen: string[] = [];
    const off = onHerdrChange((agents) => seen.push(agents.map((agent) => agent.status).join(",")));
    try {
      const agent = spawnHerdrAgent({
        name: "broadcast",
        task: "do it",
        cwd: env.dir,
        parentSessionId: "parent",
        model: faux.getModel(),
      });
      await waitForStatus(agent.id, (status) => status !== "starting", 5_000);
      assert.ok(seen.length > 0, "必须广播 herdr 变更");
      assert.ok(
        seen.some((entry) => entry.includes("running") || entry.includes("starting") || entry.includes("exited")),
      );
    } finally {
      off();
    }
  } finally {
    await env.cleanup();
  }
});

test("idle reaper sleeps an idle fleet agent but never a working one", { timeout: 30000 }, async () => {
  const env = setupEnv();
  try {
    const faux = await registerFaux("herdr-idle-fixture", ["done"]);
    const idle = spawnHerdrAgent({
      name: "idle-one",
      task: "reply",
      cwd: env.dir,
      parentSessionId: "parent",
      model: faux.getModel(),
      idle: true,
    });
    await waitForStatus(idle.id, (status) => status === "running", 5_000);

    // 刚建好：还在宽限期内，不该被休眠。
    assert.deepEqual(sweepIdleHerdrAgents({ now: Date.now(), maxIdleMs: 5 * 60_000 }), []);

    // 把空闲时间点推到 11 分钟前 → 扫到就休眠，并记下原因。
    const record = getHerdrAgent(idle.id)!;
    assert.equal(typeof record.lastActivityAt, "number");
    const slept = sweepIdleHerdrAgents({ now: record.lastActivityAt + 6 * 60_000, maxIdleMs: 5 * 60_000 });
    assert.deepEqual(slept, [idle.id]);
    const after = getHerdrAgent(idle.id)!;
    assert.equal(after.status, "stopped");
    assert.match(after.error ?? "", /自动休眠/);
    assert.equal(after.finishedAt !== null, true);
  } finally {
    await env.cleanup();
  }
});

test("the idle decision never touches a working or starting agent", () => {
  const idleView = { status: "running" as const, activity: "idle" as const, lastActivityAt: 1_000 };
  const workingView = { ...idleView, activity: "working" as const };
  const startingView = { ...idleView, status: "starting" as const };
  const stoppedView = { ...idleView, status: "stopped" as const };
  assert.equal(shouldSleepIdle(idleView, 1_000 + 11 * 60_000, 10 * 60_000), true);
  assert.equal(shouldSleepIdle(idleView, 1_000 + 9 * 60_000, 10 * 60_000), false);
  assert.equal(shouldSleepIdle(workingView, 1_000 + 60 * 60_000, 10 * 60_000), false);
  assert.equal(shouldSleepIdle(startingView, 1_000 + 60 * 60_000, 10 * 60_000), false);
  assert.equal(shouldSleepIdle(stoppedView, 1_000 + 60 * 60_000, 10 * 60_000), false);
});

test("a dispatched turn is killed on timeout instead of hanging", { timeout: 30000 }, async () => {
  const env = setupEnv();
  try {
    const runtime = await getSharedAuxRuntime();
    const hanging = fauxProvider({ provider: "herdr-hang-fixture", api: "herdr-hang-api" });
    runtime.registerNativeProvider(hanging.provider);
    // 永远不 resolve 的响应：只能靠超时收割。
    hanging.setResponses([() => new Promise(() => {})]);
    const agent = spawnHerdrAgent({
      name: "hangs",
      task: "never answers",
      cwd: env.dir,
      parentSessionId: "parent",
      model: hanging.getModel(),
      idle: true,
    });
    await waitForStatus(agent.id, (status) => status === "running", 5_000);

    void sendHerdrMessage(agent.id, "hang please", 1_000).catch(() => undefined);
    await waitFor(() => getHerdrAgent(agent.id)?.status === "stopped", "timeout kill", 8_000);
    const after = getHerdrAgent(agent.id)!;
    assert.equal(after.status, "stopped");
    assert.match(after.error ?? "", /强制终止/);
    assert.ok(after.finishedAt, "被收割也要有结束时间");
  } finally {
    await env.cleanup();
  }
});

async function waitForStatus(
  id: string,
  predicate: (status: string) => boolean,
  timeoutMs: number,
): Promise<NonNullable<ReturnType<typeof getHerdrAgent>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const agent = getHerdrAgent(id);
    if (agent && predicate(agent.status)) return agent;
    if (Date.now() > deadline) throw new Error(`timed out waiting for status (last: ${agent?.status})`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
