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
  assert.equal(BATCHING_RULES.length, 7);
  for (const line of BATCHING_RULES) {
    assert.doesNotMatch(line, /\$\{|\d{4}-\d{2}-\d{2}|[0-9a-f]{8}-[0-9a-f]{4}/i, `动态内容会破坏 prompt cache: ${line}`);
  }
  const joined = BATCHING_RULES.join("\n");
  // 合并调用是加速的第一手段（写操作不得与读取混批）。
  assert.match(joined, /同一消息里的多个调用并行执行/);
  assert.match(joined, /edit \/ write \/ git commit 不与读取混批/);
  // 预算按批次计：简单 1 批、普通 2–3 批、调研 3–4 批；单批 ≤12；每批自检，到顶先交付再问。
  assert.match(joined, /简单 1 批/);
  assert.match(joined, /调研 3–4 批/);
  assert.match(joined, /单批并行 ≤12/);
  assert.match(joined, /每批自检/);
  assert.match(joined, /timeout 30/);
  assert.match(BATCHING_RULES.join("\n"), /head \/ uniq/);
  assert.match(BATCHING_RULES.join("\n"), /一次 codemode 脚本/);
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
