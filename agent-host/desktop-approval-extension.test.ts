import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PLAN_MODE_SYSTEM_PROMPT } from "../lib/approval-policy.ts";
import { createDesktopApprovalFactory } from "./desktop-approval-extension.ts";

type Handler = (event: unknown, ctx?: unknown) => unknown;

function setup(mode: "plan" | "ask" | "full") {
  const handlers = new Map<string, Handler>();
  const activeTools: string[][] = [];
  const pi = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    setActiveTools: (names: string[]) => activeTools.push(names),
    getAllTools: () => [],
    getActiveTools: () => [],
    registerTool: () => {},
  } as unknown as ExtensionAPI;

  const modeRef = { current: mode, toolPreset: "default" as const };
  createDesktopApprovalFactory(modeRef)(pi);
  return { handlers, activeTools, modeRef };
}

function beforeAgentStartEvent(appendSystemPrompt = "") {
  return {
    type: "before_agent_start",
    prompt: "add a button",
    get systemPrompt() {
      return "BASE PROMPT";
    },
    systemPromptOptions: { appendSystemPrompt },
  };
}

test("plan mode appends the plan prompt and keeps only read tools", async () => {
  const { handlers, activeTools } = setup("plan");
  const event = beforeAgentStartEvent();
  const result = await handlers.get("before_agent_start")?.(event);

  assert.equal(result, undefined, "no forced prompt: pi keeps rendering its own sections");
  assert.equal(event.systemPromptOptions.appendSystemPrompt, PLAN_MODE_SYSTEM_PROMPT);
  // memory_recall is appended by withMemoryTools for plan mode.
  assert.deepEqual(activeTools[0].slice().sort(), ["find", "grep", "ls", "memory_recall", "read", "tool_history_get"]);
});

test("plan mode appends after an existing append prompt", async () => {
  const { handlers } = setup("plan");
  const event = beforeAgentStartEvent("CUSTOM");
  await handlers.get("before_agent_start")?.(event);
  assert.equal(event.systemPromptOptions.appendSystemPrompt, `CUSTOM\n\n${PLAN_MODE_SYSTEM_PROMPT}`);
});

test("full mode leaves the prompt untouched", async () => {
  const { handlers } = setup("full");
  const event = beforeAgentStartEvent("CUSTOM");
  const result = await handlers.get("before_agent_start")?.(event);
  assert.equal(result, undefined);
  assert.equal(event.systemPromptOptions.appendSystemPrompt, "CUSTOM");
});
