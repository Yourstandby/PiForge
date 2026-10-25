import test from "node:test";
import assert from "node:assert/strict";
import { BATCHING_RULES, OUTPUT_STYLE_BLOCK, OUTPUT_STYLE_GUIDELINES } from "./prompts/output-style.ts";
import { createDesktopOutputStyleFactory } from "./desktop-output-style-extension.ts";

test("output style guidelines are static: no timestamps, ids or interpolation", () => {
  for (const line of OUTPUT_STYLE_GUIDELINES) {
    assert.doesNotMatch(line, /\$\{|\d{4}-\d{2}-\d{2}|[0-9a-f]{8}-[0-9a-f]{4}/i, `动态内容会破坏 prompt cache: ${line}`);
  }
  assert.equal(OUTPUT_STYLE_BLOCK, OUTPUT_STYLE_GUIDELINES.join("\n"));
  // 四条硬约束 + 一条「推理不打折」的平衡说明。
  assert.equal(OUTPUT_STYLE_GUIDELINES.length, 6);
});

test("batching rules are static, independent of the output-style switch", () => {
  assert.equal(BATCHING_RULES.length, 5);
  for (const line of BATCHING_RULES) {
    assert.doesNotMatch(line, /\$\{|\d{4}-\d{2}-\d{2}|[0-9a-f]{8}-[0-9a-f]{4}/i, `动态内容会破坏 prompt cache: ${line}`);
  }
  // 预算写死：每用户轮 <8 次，第 4 次必须中途自检，到顶先交付再问。
  assert.match(BATCHING_RULES.join("\n"), /每个用户轮工具调用 <8 次/);
  assert.match(BATCHING_RULES.join("\n"), /中途自检/);
  assert.match(BATCHING_RULES.join("\n"), /先交付可验证的结论/);
  // 并行上限必须写死在提示里（硬护栏在 desktop-tool-guard-extension，这里是软约束）。
  assert.match(BATCHING_RULES.join("\n"), /同一批并行 ≤8/);
  assert.match(BATCHING_RULES.join("\n"), /显式传 timeout/);
});

function hookInto(options?: { enabled?: () => boolean }) {
  let handler: ((event: { systemPromptOptions: { promptGuidelines?: string[] } }) => void) | undefined;
  const factory = createDesktopOutputStyleFactory(options);
  const pi = {
    on: (name: string, cb: unknown) => {
      if (name === "before_agent_start") handler = cb as typeof handler;
    },
  };
  factory(pi as never);
  assert.ok(handler, "must hook before_agent_start");
  return handler!;
}

test("the extension appends the guidelines exactly once per prompt build", () => {
  const handler = hookInto();
  const options: { promptGuidelines?: string[] } = {};
  handler({ systemPromptOptions: options });
  assert.deepEqual(options.promptGuidelines, [...OUTPUT_STYLE_GUIDELINES, ...BATCHING_RULES]);

  // 再跑一次（多扩展 / 重载）不应该重复追加，否则前缀会一直变长。
  handler({ systemPromptOptions: options });
  assert.equal(options.promptGuidelines!.length, OUTPUT_STYLE_GUIDELINES.length + BATCHING_RULES.length);
});

test("turning output style off keeps the batching rules in the prefix", () => {
  const handler = hookInto({ enabled: () => false });
  const options: { promptGuidelines?: string[] } = {};
  handler({ systemPromptOptions: options });
  assert.deepEqual(options.promptGuidelines, [...BATCHING_RULES]);
});
