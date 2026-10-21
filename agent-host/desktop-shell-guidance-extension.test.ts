import test from "node:test";
import assert from "node:assert/strict";
import { createDesktopShellGuidanceFactory } from "./desktop-shell-guidance-extension.ts";

type Handler = (event: { systemPromptOptions: { promptGuidelines?: string[] } }) => void;

function setup() {
  const handlers = new Map<string, Handler>();
  const pi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
    },
  };
  createDesktopShellGuidanceFactory()(pi as never);
  return handlers;
}

test("appends bash/powershell guidance bullets once", () => {
  const handlers = setup();
  const handler = handlers.get("before_agent_start");
  assert.ok(handler, "registers before_agent_start");
  const options: { promptGuidelines?: string[] } = { promptGuidelines: [] };
  handler({ systemPromptOptions: options });
  const first = options.promptGuidelines ?? [];
  assert.equal(first.length, 4);
  assert.ok(first.some((line) => line.includes("prefer the `powershell` tool")));
  assert.ok(first.some((line) => line.includes("Batch independent commands")));

  handler({ systemPromptOptions: options });
  assert.equal(options.promptGuidelines?.length, 4, "idempotent across turns");
});
