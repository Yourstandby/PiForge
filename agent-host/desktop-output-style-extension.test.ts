import test from "node:test";
import assert from "node:assert/strict";
import { OUTPUT_STYLE_BLOCK, OUTPUT_STYLE_GUIDELINES } from "./prompts/output-style.ts";
import { createDesktopOutputStyleFactory } from "./desktop-output-style-extension.ts";

test("output style guidelines are static: no timestamps, ids or interpolation", () => {
  for (const line of OUTPUT_STYLE_GUIDELINES) {
    assert.doesNotMatch(line, /\$\{|\d{4}-\d{2}-\d{2}|[0-9a-f]{8}-[0-9a-f]{4}/i, `动态内容会破坏 prompt cache: ${line}`);
  }
  assert.equal(OUTPUT_STYLE_BLOCK, OUTPUT_STYLE_GUIDELINES.join("\n"));
  // 四条硬约束 + 一条「推理不打折」的平衡说明。
  assert.equal(OUTPUT_STYLE_GUIDELINES.length, 6);
});

test("the extension appends the guidelines exactly once per prompt build", () => {
  let handler: ((event: { systemPromptOptions: { promptGuidelines?: string[] } }) => void) | undefined;
  const factory = createDesktopOutputStyleFactory();
  const pi = {
    on: (name: string, cb: unknown) => {
      if (name === "before_agent_start") handler = cb as typeof handler;
    },
  };
  factory(pi as never);
  assert.ok(handler, "must hook before_agent_start");

  const options: { promptGuidelines?: string[] } = {};
  handler!({ systemPromptOptions: options });
  assert.deepEqual(options.promptGuidelines, [...OUTPUT_STYLE_GUIDELINES]);

  // 再跑一次（多扩展 / 重载）不应该重复追加，否则前缀会一直变长。
  handler!({ systemPromptOptions: options });
  assert.equal(options.promptGuidelines!.length, OUTPUT_STYLE_GUIDELINES.length);
});
