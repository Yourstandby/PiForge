import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
  getHerdrAgent,
  listHerdrAgents,
  resetHerdrForTest,
  sendHerdrMessage,
  spawnHerdrAgent,
  stopAllHerdrAgents,
  stopHerdrAgent,
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
    assert.equal(result.agent.verification.verified, true);
    assert.match(result.agent.verification.reason, /通过证据/);
    assert.match(result.text, /5 passed/);
  } finally {
    await env.cleanup();
  }
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
