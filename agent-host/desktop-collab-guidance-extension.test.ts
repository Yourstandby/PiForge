import assert from "node:assert/strict";
import test from "node:test";
import {
  createDesktopCollabGuidanceFactory,
  desktopCollabGuidanceInlineExtension,
} from "./desktop-collab-guidance-extension.ts";
import { COLLAB_GUIDELINES } from "./prompts/collab.ts";

type Handler = (event: { systemPromptOptions: { promptGuidelines?: string[] } }) => unknown;

function harness(options: { enabled?: () => boolean } = {}) {
  let handler: Handler | null = null;
  createDesktopCollabGuidanceFactory(options)({
    on: (event: string, fn: Handler) => {
      if (event === "before_agent_start") handler = fn;
    },
  } as never);
  const run = (existing?: string[]) => {
    const systemPromptOptions: { promptGuidelines?: string[] } = existing
      ? { promptGuidelines: [...existing] }
      : {};
    handler!({ systemPromptOptions });
    return systemPromptOptions.promptGuidelines ?? [];
  };
  return { run };
}

test("collab guidelines are appended once and stay idempotent", () => {
  const { run } = harness();
  const first = run();
  assert.deepEqual(first, [...COLLAB_GUIDELINES]);

  const again = run(first);
  assert.equal(again.length, COLLAB_GUIDELINES.length, "重复注入不会叠加");
});

test("existing guidelines are preserved in order", () => {
  const { run } = harness();
  const merged = run(["--keep-me--"]);
  assert.equal(merged[0], "--keep-me--");
  assert.deepEqual(merged.slice(1), [...COLLAB_GUIDELINES]);
});

test("the setting can switch the block off", () => {
  const { run } = harness({ enabled: () => false });
  assert.deepEqual(run(), []);
});

test("guidelines are static: no timestamps, session ids or paths leak into the prefix", () => {
  for (const line of COLLAB_GUIDELINES) {
    assert.doesNotMatch(line, /\d{10,}/, `unexpected timestamp-like token: ${line}`);
    assert.doesNotMatch(line, /[A-Za-z]:\\\\|\\\\Users\\\\|\/home\//, `unexpected absolute path: ${line}`);
    assert.ok(line.length > 20, "each guideline must carry an actionable instruction");
  }
});

test("inline extension is named and exposes a factory", () => {
  const ext = desktopCollabGuidanceInlineExtension();
  assert.equal(typeof ext, "object");
  assert.equal("name" in ext && ext.name, "desktop-collab-guidance");
  assert.equal("factory" in ext && typeof ext.factory, "function");
});
