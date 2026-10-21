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

test("Herdr spawn traverses starting → running and stays idle for messages", { timeout: 30000 }, async () => {
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

    await waitFor(() => {
      const agent = getHerdrAgent(spawned.id);
      return agent?.status === "running" && agent.activity === "idle" && agent.turns === 1;
    }, "fleet agent idle");

    const idle = getHerdrAgent(spawned.id)!;
    assert.equal(idle.output.includes("initial report"), true);
    assert.equal(idle.verification.verified, false);
    assert.match(idle.verification.reason, /未找到/);
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
    });
    await waitFor(() => getHerdrAgent(spawned.id)?.activity === "idle", "initial turn");

    const result = await sendHerdrMessage(spawned.id, "Run the test suite and report.");
    assert.equal(result.ok, true, result.error);
    assert.equal(result.agent.turns, 2);
    assert.equal(result.agent.verification.verified, false);
    assert.match(result.agent.verification.reason, /只有文本自述/);
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
    });
    await waitFor(() => getHerdrAgent(spawned.id)?.activity === "idle", "idle before stop");
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

test("a fleet agent refuses the 4th message (3-round money valve)", { timeout: 30000 }, async () => {
  const env = setupEnv();
  try {
    const faux = await registerFaux("herdr-turns-fixture", ["r1", "r2", "r3"]);
    const agent = spawnHerdrAgent({
      name: "turn-capped",
      task: "first task",
      cwd: env.dir,
      parentSessionId: "parent",
      model: faux.getModel(),
    });
    // 第 1 轮由 spawn 的初始任务占用；再发 2 轮 → 共 3 轮，已达上限。
    const second = await sendHerdrMessage(agent.id, "second");
    assert.match(second.text, /r2|r3/);
    const third = await sendHerdrMessage(agent.id, "third");
    assert.match(third.text, /r3/);
    await assert.rejects(
      () => sendHerdrMessage(agent.id, "fourth"),
      (error: unknown) => error instanceof Error && /轮数上限|3 轮/.test(error.message),
    );
    assert.equal(getHerdrAgent(agent.id)?.turns, 3);
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
      await waitForStatus(agent.id, (status) => status === "running", 5_000);
      assert.ok(seen.length > 0, "必须广播 herdr 变更");
      assert.ok(seen.some((entry) => entry.includes("running") || entry.includes("starting")));
    } finally {
      off();
    }
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
