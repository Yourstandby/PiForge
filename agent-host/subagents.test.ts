import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
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

test("spawnSubagent marks explicit test evidence as verified", { timeout: 30000 }, async () => {
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
    assert.equal(result.agent.verification?.verified, true);
    assert.match(result.agent.verification?.reason ?? "", /通过证据/);
    assert.match(result.text, /Verification: test\/build evidence found/);
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
