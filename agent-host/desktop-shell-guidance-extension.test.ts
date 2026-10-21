import test from "node:test";
import assert from "node:assert/strict";
import { createDesktopShellGuidanceFactory } from "./desktop-shell-guidance-extension.ts";

type Handler = (event: { systemPromptOptions: { promptGuidelines?: string[] } }) => void;

function setup(platform: NodeJS.Platform = "win32") {
  const handlers = new Map<string, Handler>();
  const pi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
    },
  };
  // 平台显式注入：Windows 上跑 Linux CI 才不会因为 process.platform 而假失败。
  createDesktopShellGuidanceFactory({ platform })(pi as never);
  return handlers;
}

test("registers nothing outside Windows", () => {
  for (const platform of ["linux", "darwin"] as const) {
    assert.equal(setup(platform).size, 0, `${platform} must stay silent`);
  }
});

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
