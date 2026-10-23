import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "./sdk-adapter.ts";
import { createDesktopProcessFactory } from "./desktop-process-extension.ts";
import {
  forceStopManagedProcess,
  resetManagedProcessesForTest,
  startManagedProcess,
} from "./managed-processes.ts";
import {
  resetProcessInstanceStateForTest,
  shutdownProcessInstanceState,
} from "./process-instance-store.ts";
import { desktopRuntimeTools } from "./desktop-runtime-tools.ts";

interface ToolDefinition {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<{ content: Array<{ type: string; text?: string }>; details?: Record<string, unknown> }>;
}

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pi-process-tools-"));
  const previous = process.env[AGENT_DIR_ENV];
  process.env[AGENT_DIR_ENV] = join(dir, "agent");
  resetProcessInstanceStateForTest();
  const tools: ToolDefinition[] = [];
  const pi = {
    on: () => () => {},
    registerTool: (definition: ToolDefinition) => tools.push(definition),
    setActiveTools: () => {},
    getAllTools: () => [],
    getActiveTools: () => [],
  } as unknown as ExtensionAPI;
  createDesktopProcessFactory({ getCwd: () => dir })(pi);
  return {
    dir,
    tools,
    cleanup: async () => {
      await resetManagedProcessesForTest();
      shutdownProcessInstanceState();
      resetProcessInstanceStateForTest();
      if (previous === undefined) delete process.env[AGENT_DIR_ENV];
      else process.env[AGENT_DIR_ENV] = previous;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}


function tool(tools: ToolDefinition[], name: string): ToolDefinition {
  const found = tools.find((candidate) => candidate.name === name);
  assert.ok(found, `missing tool ${name}`);
  return found;
}

test("registers only run_bg / process_read / process_wait (no stop/restart tools)", () => {
  const env = setup();
  try {
    assert.deepEqual(
      env.tools.map((entry) => entry.name).sort(),
      ["process_read", "process_wait", "run_bg"],
    );
    const names = env.tools.map((entry) => entry.name);
    assert.ok(!names.includes("process_stop"));
    assert.ok(!names.includes("process_restart"));
    // 三个动作收进 shell 多态工具：旧名字只以 deferred 注册（可调用、不声明）。
    for (const entry of env.tools) {
      assert.equal(
        (entry as { exposure?: string }).exposure,
        "deferred",
        `${entry.name} must stay callable but undeclared`,
      );
    }
    const toolInfos = [
      ...env.tools.map((entry) => ({ name: entry.name, description: "" })),
      { name: "shell", description: "" },
    ];
    const declared = desktopRuntimeTools("full", "default", false, toolInfos, []);
    assert.ok(declared.includes("shell"), "the shell facade carries run/read/wait");
    for (const legacy of ["run_bg", "process_read", "process_wait"]) {
      assert.ok(!declared.includes(legacy), `${legacy} must not be declared on its own`);
    }
  } finally {
    void env.cleanup();
  }
});

test("process_wait(ready) then process_read with a cursor", { timeout: 40000 }, async () => {
  const env = setup();
  try {
    const started = startManagedProcess({
      cwd: env.dir,
      command: `node -e "console.log('Local: http://localhost:45678/'); console.log('ready in 10ms'); let i=0; setInterval(()=>console.log('tick '+(++i)),50)"`,
      owner: "agent",
    });

    const wait = await tool(env.tools, "process_wait").execute(
      "wait-1",
      { processId: started.id, for: "ready", timeoutMs: 15000 },
      undefined,
      undefined,
      undefined,
    );
    assert.equal(wait.details?.ok, true, wait.content[0]?.text);
    assert.match(wait.content[0]?.text ?? "", /is ready/);
    assert.match(wait.content[0]?.text ?? "", /localhost:45678/);

    const first = await tool(env.tools, "process_read").execute(
      "read-1",
      { processId: started.id, limit: 3 },
      undefined,
      undefined,
      undefined,
    );
    assert.equal(first.details?.kind, "process-read");
    assert.equal(first.details?.ok, true);
    assert.ok((first.details?.nextCursor as number) >= 1);
    assert.match(first.content[0]?.text ?? "", /ready in 10ms/);

    await new Promise((resolve) => setTimeout(resolve, 250));
    const next = await tool(env.tools, "process_read").execute(
      "read-2",
      { processId: started.id, cursor: first.details?.nextCursor, limit: 5 },
      undefined,
      undefined,
      undefined,
    );
    assert.equal(next.details?.ok, true);
    assert.match(next.content[0]?.text ?? "", /tick /);

    await forceStopManagedProcess(started.id);
  } finally {
    await env.cleanup();
  }
});

test("process_wait(exit) reports natural termination", { timeout: 30000 }, async () => {
  const env = setup();
  try {
    const started = startManagedProcess({
      cwd: env.dir,
      command: `node -e "setTimeout(()=>process.exit(0), 200)"`,
      owner: "agent",
    });
    const result = await tool(env.tools, "process_wait").execute(
      "wait-exit",
      { processId: started.id, for: "exit", timeoutMs: 15000 },
      undefined,
      undefined,
      undefined,
    );
    assert.equal(result.details?.ok, true, result.content[0]?.text);
    assert.equal(result.details?.status, "exited");
    assert.equal(result.details?.exitReason, "natural");
    assert.match(result.content[0]?.text ?? "", /ended/);
  } finally {
    await env.cleanup();
  }
});

test("process_wait times out without stopping the process", { timeout: 30000 }, async () => {
  const env = setup();
  try {
    const started = startManagedProcess({
      cwd: env.dir,
      command: `node -e "setInterval(()=>{}, 1000)"`,
      owner: "agent",
    });
    const result = await tool(env.tools, "process_wait").execute(
      "wait-timeout",
      { processId: started.id, for: "ready", timeoutMs: 1000 },
      undefined,
      undefined,
      undefined,
    );
    assert.equal(result.details?.ok, false);
    assert.equal(result.details?.timedOut, true);
    assert.match(result.content[0]?.text ?? "", /Timed out/);
    assert.match(result.content[0]?.text ?? "", /process_read/);
    await forceStopManagedProcess(started.id);
  } finally {
    await env.cleanup();
  }
});

test("tools reject unknown process ids", async () => {
  const env = setup();
  try {
    const read = await tool(env.tools, "process_read").execute(
      "read-missing",
      { processId: "missing" },
      undefined,
      undefined,
      undefined,
    );
    assert.equal(read.details?.ok, false);
    assert.match(read.content[0]?.text ?? "", /No managed process/);

    const wait = await tool(env.tools, "process_wait").execute(
      "wait-missing",
      { processId: "missing" },
      undefined,
      undefined,
      undefined,
    );
    assert.equal(wait.details?.ok, false);
    assert.match(wait.content[0]?.text ?? "", /No managed process/);
  } finally {
    await env.cleanup();
  }
});
