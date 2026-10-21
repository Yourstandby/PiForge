import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "./sdk-adapter.ts";
import type { ExtensionAPI } from "./sdk-adapter.ts";
import { createDesktopSubagentFactory } from "./desktop-subagent-extension.ts";
import { getSharedAuxRuntime, invalidateAuxRuntime } from "./aux-models.ts";
import { resetSubagentsForTest, stopAllSubagents } from "./subagents.ts";

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

test("spawn_agent tool returns the sub-agent report and details", { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-spawn-tool-"));
  const previous = process.env[AGENT_DIR_ENV];
  process.env[AGENT_DIR_ENV] = join(dir, "agent");
  invalidateAuxRuntime();
  try {
    const tools: ToolDefinition[] = [];
    const pi = {
      on: () => () => {},
      registerTool: (definition: ToolDefinition) => tools.push(definition),
      setActiveTools: () => {},
      getAllTools: () => [],
      getActiveTools: () => [],
    } as unknown as ExtensionAPI;
    createDesktopSubagentFactory()(pi);

    const runtime = await getSharedAuxRuntime();
    const faux = fauxProvider({ provider: "spawn-tool-fixture", api: "spawn-tool-fixture-api" });
    runtime.registerNativeProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("the routed answer")]);

    const tool = tools.find((candidate) => candidate.name === "spawn_agent");
    assert.ok(tool);
    const ctx = {
      cwd: dir,
      model: faux.getModel(),
      thinkingLevel: "low" as const,
      sessionManager: { getSessionId: () => "main-session" },
    };
    const result = await tool.execute(
      "call-1",
      { name: "helper", taskPrompt: "Find the answer." },
      undefined,
      undefined,
      ctx,
    );
    assert.match(result.content[0]?.text ?? "", /the routed answer/);
    assert.equal(result.details?.kind, "subagent");
    assert.equal(result.details?.ok, true);
    assert.equal(result.details?.name, "helper");
    assert.equal(result.details?.status, "completed");
  } finally {
    await stopAllSubagents();
    resetSubagentsForTest();
    invalidateAuxRuntime();
    if (previous === undefined) delete process.env[AGENT_DIR_ENV];
    else process.env[AGENT_DIR_ENV] = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
