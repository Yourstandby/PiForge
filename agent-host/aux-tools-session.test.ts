import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { desktopApprovalInlineExtension, type AgentModeRef } from "./desktop-approval-extension.ts";
import { desktopImageInlineExtension } from "./desktop-image-extension.ts";
import { desktopDecisionInlineExtension } from "./desktop-decision-extension.ts";
import { desktopRuntimeTools } from "./desktop-runtime-tools.ts";
import { auxToolAvailability, invalidateAuxRuntime } from "./aux-models.ts";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const IMAGE_MODEL = { provider: "openrouter", modelId: "black-forest-labs/flux.2-pro" };
const DECISION_MODEL = { provider: "openai", modelId: "gpt-6-luna" };

test("aux model tools are registered, inactive by default and activate from settings", { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-aux-tools-"));
  const previous = process.env[AGENT_DIR_ENV];
  process.env[AGENT_DIR_ENV] = dir;
  invalidateAuxRuntime();
  writeFileSync(
    join(dir, "desktop-settings.json"),
    JSON.stringify({
      defaultAgentMode: "full",
      defaultToolPreset: "default",
      imageModel: IMAGE_MODEL,
      decisionModel: DECISION_MODEL,
    }),
  );
  const ref: AgentModeRef = { current: "full", toolPreset: "default", codemodeEnabled: false };
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    noExtensions: true,
    extensionFactories: [
      desktopImageInlineExtension(),
      desktopDecisionInlineExtension(),
      desktopApprovalInlineExtension(ref),
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(dir),
    noTools: "builtin",
  });
  try {
    await session.bindExtensions({ mode: "rpc", uiContext: { confirm: async () => false, notify: () => {} } as never });
    const names = session.getAllTools().map((tool) => tool.name);
    assert.ok(names.includes("generate_image"), "generate_image should be registered");
    assert.ok(names.includes("classify_decision"), "classify_decision should be registered");

    // defaultActive:false keeps both out of the model's tool list.
    assert.ok(!session.getActiveToolNames().includes("generate_image"));
    assert.ok(!session.getActiveToolNames().includes("classify_decision"));

    // Settings drive activation; the pure policy adds them only when configured.
    assert.deepEqual(auxToolAvailability(), { image: true, decision: true });
    session.setActiveToolsByName(
      desktopRuntimeTools(
        ref.current,
        "default",
        false,
        session.getAllTools(),
        session.getActiveToolNames(),
        auxToolAvailability(),
      ),
    );
    assert.ok(session.getActiveToolNames().includes("generate_image"));
    assert.ok(session.getActiveToolNames().includes("classify_decision"));

    const ctx = session.extensionRunner.createToolContext("aux-test", undefined);
    const decisionTool = session.extensionRunner
      .getAllRegisteredTools()
      .find((tool) => tool.definition.name === "classify_decision");
    assert.ok(decisionTool);
    const outcome = await decisionTool.definition.execute(
      "aux-test",
      { question: "How risky is this?", mode: "choice", choices: ["low", "high"] },
      undefined,
      undefined,
      ctx,
    );
    // No credentials in the temp agent dir: the tool reports it instead of throwing.
    assert.match(JSON.stringify(outcome.content), /not configured|风险/i);

    const imageTool = session.extensionRunner
      .getAllRegisteredTools()
      .find((tool) => tool.definition.name === "generate_image");
    assert.ok(imageTool);
    const imageOutcome = await imageTool.definition.execute(
      "aux-test",
      { prompt: "a cat" },
      undefined,
      undefined,
      ctx,
    );
    assert.match(JSON.stringify(imageOutcome.content), /failed|not configured/i);
  } finally {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
    if (previous === undefined) delete process.env[AGENT_DIR_ENV];
    else process.env[AGENT_DIR_ENV] = previous;
    invalidateAuxRuntime();
    rmSync(dir, { recursive: true, force: true });
  }
});
