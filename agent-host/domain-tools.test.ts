import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import {
  buildDomainToolDefinitions,
  registerDeferredTool,
  registerDomainAction,
  registeredDomainActions,
  resetDomainRegistry,
} from "./domain-tools.ts";
import { SHELL_GUIDANCE } from "./desktop-shell-guidance-extension.ts";

interface FakeTool {
  name: string;
  exposure?: string;
  defaultActive?: boolean;
  parameters?: unknown;
  execute?: (...args: unknown[]) => Promise<unknown>;
}

function fakePi() {
  const tools: FakeTool[] = [];
  return {
    tools,
    api: {
      registerTool: (definition: FakeTool) => {
        tools.push(definition);
      },
      getAllTools: () => [],
      getActiveTools: () => [],
      setActiveTools: () => {},
    },
  };
}

function toolDefinition(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
  execute: () => Promise<unknown> = async () => ({ content: [], details: {} })
): never {
  return {
    name,
    label: name,
    description,
    parameters: Type.Unsafe({ type: "object", properties, required, additionalProperties: false }),
    execute,
  } as never;
}

test.beforeEach(() => resetDomainRegistry());

test("mirrors every action as a deferred tool (callable, never declared)", () => {
  const { api, tools } = fakePi();
  registerDomainAction(
    api as never,
    "shell",
    "run",
    toolDefinition("run_bg", "Start bg.", { command: { type: "string", description: "cmd" } }, ["command"])
  );
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "run_bg");
  assert.equal(tools[0].exposure, "deferred");
  assert.equal(tools[0].defaultActive, false);
});

test("rejects a route/tool mismatch so the table cannot drift from the code", () => {
  const { api } = fakePi();
  assert.throws(
    () => registerDomainAction(api as never, "shell", "run", toolDefinition("not_run_bg", "x", {})),
    /routes to run_bg/
  );
});

test("composes one schema per domain with per-action required params preserved", () => {
  const { api } = fakePi();
  registerDomainAction(
    api as never,
    "shell",
    "run",
    toolDefinition("run_bg", "Start bg.", { command: { type: "string", description: "cmd" } }, ["command"])
  );
  registerDomainAction(
    api as never,
    "shell",
    "read",
    toolDefinition(
      "process_read",
      "Read logs.",
      { processId: { type: "string", description: "id" }, cursor: { type: "number" } },
      ["processId"]
    )
  );
  const [shell] = buildDomainToolDefinitions();
  assert.equal(shell.name, "shell");
  assert.match(shell.description ?? "", /- run \(requires command\)/);
  assert.match(shell.description ?? "", /- read \(requires processId; opt cursor\)/);
  const parameters = shell.parameters as unknown as {
    properties: Record<string, unknown>;
    required: string[];
  };
  assert.deepEqual(parameters.required, ["action"]);
  assert.deepEqual(parameters.properties.action, {
    type: "string",
    enum: ["run", "read"],
    description: "What to do. See the parameter lists in this tool's description.",
  });
  assert.ok("command" in parameters.properties);
  assert.ok("processId" in parameters.properties);
});

test("shell guidelines ride on the shell facade only", () => {
  const { api } = fakePi();
  registerDomainAction(api as never, "shell", "run", toolDefinition("run_bg", "Start bg.", {}));
  registerDomainAction(api as never, "memory", "recall", toolDefinition("memory_recall", "Search.", {}));
  const definitions = buildDomainToolDefinitions();
  const shell = definitions.find((definition) => definition.name === "shell");
  const memory = definitions.find((definition) => definition.name === "memory");
  // buildDomainToolDefinitions 不挂 guidelines；域扩展负责把 4 条挂到 shell 上。
  assert.equal(shell?.promptGuidelines, undefined);
  assert.equal(memory?.promptGuidelines, undefined);
  assert.equal(SHELL_GUIDANCE.length, 4);
});

test("dispatches through ctx.executeTool with the legacy tool name and args", async () => {
  const { api } = fakePi();
  registerDomainAction(
    api as never,
    "browser",
    "read",
    toolDefinition("browser_read", "Read page.", { maxChars: { type: "number" } })
  );
  const [browser] = buildDomainToolDefinitions();
  const calls: Array<{ name: string; args: unknown }> = [];
  const ctx = {
    executeTool: async (name: string, args: unknown) => {
      calls.push({ name, args });
      return { result: { content: [{ type: "text", text: "page" }], details: { ok: true } }, isError: false };
    },
  };
  const result = (await browser.execute?.(
    "call-1",
    { action: "read", maxChars: 42 } as never,
    undefined,
    undefined,
    ctx as never
  )) as { content: Array<{ text: string }>; details: unknown };

  assert.deepEqual(calls, [{ name: "browser_read", args: { maxChars: 42, action: "read" } }]);
  assert.equal(result.content[0].text, "page");
  assert.deepEqual(result.details, { ok: true });
});

test("keeps the legacy action value when an action maps onto a sub-action", async () => {
  const { api } = fakePi();
  registerDomainAction(
    api as never,
    "browser",
    "screenshot",
    toolDefinition("browser_read", "Read page.", {})
  );
  const [browser] = buildDomainToolDefinitions();
  const calls: Array<{ name: string; args: unknown }> = [];
  await browser.execute?.(
    "call-1",
    { action: "screenshot" } as never,
    undefined,
    undefined,
    {
      executeTool: async (name: string, args: unknown) => {
        calls.push({ name, args });
        return { result: { content: [], details: {} }, isError: false };
      },
    } as never
  );
  assert.deepEqual(calls, [{ name: "browser_read", args: { action: "screenshot" } }]);
});

test("unknown action and missing required params fail loudly instead of running", async () => {
  const { api } = fakePi();
  registerDomainAction(
    api as never,
    "shell",
    "run",
    toolDefinition("run_bg", "Start bg.", { command: { type: "string" } }, ["command"])
  );
  const [shell] = buildDomainToolDefinitions();
  let dispatched = false;
  const ctx = {
    executeTool: async () => {
      dispatched = true;
      return { result: { content: [], details: {} }, isError: false };
    },
  };

  const unknown = (await shell.execute?.("c", { action: "nope" } as never, undefined, undefined, ctx as never)) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /Unknown action "nope" for tool "shell"/);

  const missing = (await shell.execute?.("c", { action: "run" } as never, undefined, undefined, ctx as never)) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /action "run" requires: command/);
  assert.equal(dispatched, false, "a failing validation must not dispatch");
});

test("conflicting parameter constraints for the same property reject the merge", () => {
  const { api } = fakePi();
  registerDomainAction(
    api as never,
    "shell",
    "run",
    toolDefinition("run_bg", "Start bg.", { timeoutMs: { type: "number", maximum: 10 } })
  );
  registerDomainAction(
    api as never,
    "shell",
    "wait",
    toolDefinition("process_wait", "Wait.", { timeoutMs: { type: "number", maximum: 20 } })
  );
  assert.throws(() => buildDomainToolDefinitions(), /conflicting parameter schema/);
});

test("duplicate property descriptions keep the most informative one instead of paying twice", () => {
  const { api } = fakePi();
  registerDomainAction(
    api as never,
    "fleet",
    "spawn",
    toolDefinition("spawn_agent", "One-shot.", { name: { type: "string", description: "short" } })
  );
  registerDomainAction(
    api as never,
    "fleet",
    "launch",
    toolDefinition("herdr_spawn", "Persistent.", {
      name: { type: "string", description: "the much longer description of the same field" },
    })
  );
  const [fleet] = buildDomainToolDefinitions();
  const parameters = fleet.parameters as unknown as {
    properties: Record<string, { description?: string }>;
  };
  assert.equal(parameters.properties.name.description, "the much longer description of the same field");
});

test("registerDeferredTool mirrors without joining any domain", () => {
  const { api, tools } = fakePi();
  registerDeferredTool(api as never, toolDefinition("web_preview", "Panel browser.", {}));
  assert.equal(tools[0].name, "web_preview");
  assert.equal(tools[0].exposure, "deferred");
  assert.equal(registeredDomainActions().length, 0);
});

test("on-demand domains (memory/orchestrator) are registered deferred, always-on ones direct", () => {
  const { api } = fakePi();
  registerDomainAction(api as never, "shell", "run", toolDefinition("run_bg", "Start bg.", {}));
  registerDomainAction(api as never, "memory", "recall", toolDefinition("memory_recall", "Search.", {}));
  registerDomainAction(
    api as never,
    "orchestrator",
    "status",
    toolDefinition("orchestrator_status", "List workers.", {})
  );
  const definitions = buildDomainToolDefinitions();
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  assert.equal(byName.get("shell")?.exposure, undefined);
  assert.equal(byName.get("shell")?.defaultActive, true);
  assert.equal(byName.get("memory")?.exposure, "deferred");
  assert.equal(byName.get("memory")?.defaultActive, false);
  assert.equal(byName.get("orchestrator")?.exposure, "deferred");
  // tool_search 只回显 description 的第一行：第一行必须是「域: 动作列表」。
  assert.match(byName.get("memory")?.description ?? "", /^Memory: recall\./);
});
