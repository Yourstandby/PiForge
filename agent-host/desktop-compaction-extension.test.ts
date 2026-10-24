import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "./sdk-adapter.ts";
import { createDesktopCompactionFactory } from "./desktop-compaction-extension.ts";
import { KEEP_RECENT_ROUNDS, type SessionEntryLike } from "./compaction-plan.ts";

type Handler = (event: unknown, ctx?: unknown) => unknown;

interface CompactCall {
  customInstructions?: string;
  onComplete?: (result: unknown) => void;
  onError?: (error: Error) => void;
}

/** 每轮 = user + assistant(edit) + toolResult，方便断言区间。 */
function branch(rounds: number, startId = 0): SessionEntryLike[] {
  const entries: SessionEntryLike[] = [];
  for (let index = startId; index < startId + rounds; index += 1) {
    entries.push({
      type: "message",
      id: `u${index}`,
      message: { role: "user", content: [{ type: "text", text: `task ${index}` }] },
    });
    entries.push({
      type: "message",
      id: `a${index}`,
      message: {
        role: "assistant",
        // 真实一轮动辄几千字符；这里塞够体积，让「被压区间够大」的闸门通过。
        content: [{ type: "text", text: `changed ${index} ${"x".repeat(4_000)}` }],
        toolCalls: [{ name: "edit", arguments: { path: `src/file-${index}.ts` } }],
      },
    });
    entries.push({
      type: "message",
      id: `r${index}`,
      message: { role: "toolResult", content: [{ type: "text", text: `ok ${index}` }] },
    });
  }
  return entries;
}

function setup(options: {
  entries: SessionEntryLike[];
  tokens?: number | null;
  contextWindow?: number;
  summarize?: (input: unknown) => Promise<string | null>;
  keepRounds?: number;
  minDropRounds?: number;
}) {
  const handlers = new Map<string, Handler>();
  const compactions: CompactCall[] = [];
  const logs: string[] = [];
  const pi = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    registerTool: () => {},
    setActiveTools: () => {},
    getAllTools: () => [],
    getActiveTools: () => [],
  } as unknown as ExtensionAPI;

  createDesktopCompactionFactory({
    getEntries: () => options.entries,
    getTarget: () => undefined,
    keepRounds: options.keepRounds,
    minDropRounds: options.minDropRounds,
    summarize:
      options.summarize ??
      (async (input) => {
        const messages = (input as unknown as { messages: Array<{ role?: string }> }).messages;
        return `## 1. 用户核心意图\n- 共 ${messages.length} 条消息被压缩，原文见历史。\n## 2. 修改过的文件\n- 见清单\n## 3. 关键报错 / 事实\n- 无\n## 4. 最终决策\n- 继续实现`;
      }),
    log: (message) => logs.push(message),
  })(pi);

  const ctx = {
    isIdle: () => true,
    getContextUsage: () => ({
      tokens: options.tokens ?? null,
      contextWindow: options.contextWindow ?? 0,
      percent: null,
    }),
    sessionManager: { getBranch: () => options.entries },
    compact: (call: CompactCall) => compactions.push(call),
  };
  return { handlers, compactions, logs, ctx };
}

test("window full triggers exactly one compaction", async () => {
  const entries = branch(KEEP_RECENT_ROUNDS + 3);
  const { handlers, compactions, ctx, logs } = setup({ entries });
  await handlers.get("agent_settled")?.({ type: "agent_settled", aborted: false }, ctx);
  assert.equal(compactions.length, 1);
  assert.match(compactions[0].customInstructions ?? "", /核心任务目标/);
  assert.ok(logs.some((line) => line.includes("trigger")));

  // 同一状态再来一次（onComplete 没回调）也不应重复触发
  await handlers.get("agent_settled")?.({ type: "agent_settled", aborted: false }, ctx);
  assert.equal(compactions.length, 1, "同轮数不重复触发");
});

test("token budget triggers even when the window rule would not", async () => {
  // keepRounds=2 + minDropRounds=99 → 只剩「预算超限」这一条路。
  const entries = branch(5);
  const { handlers, compactions, ctx } = setup({
    entries,
    keepRounds: 2,
    minDropRounds: 99,
    tokens: 190_000,
    contextWindow: 200_000,
  });
  await handlers.get("agent_settled")?.({ type: "agent_settled", aborted: false }, ctx);
  assert.equal(compactions.length, 1, "预算超限必须能单独触发");
});

test("a short conversation is left alone", async () => {
  const { handlers, compactions, ctx } = setup({ entries: branch(3) });
  await handlers.get("agent_settled")?.({ type: "agent_settled", aborted: false }, ctx);
  assert.equal(compactions.length, 0);
});

test("aborted runs and busy sessions never trigger", async () => {
  const entries = branch(KEEP_RECENT_ROUNDS + 4);
  const first = setup({ entries });
  await first.handlers.get("agent_settled")?.({ type: "agent_settled", aborted: true }, first.ctx);
  assert.equal(first.compactions.length, 0);

  const second = setup({ entries });
  await second.handlers.get("agent_settled")?.(
    { type: "agent_settled", aborted: false },
    { ...second.ctx, isIdle: () => false },
  );
  assert.equal(second.compactions.length, 0);
});

test("session_before_compact supplies a round-aligned structured summary", async () => {
  const entries = branch(10);
  const { handlers, ctx } = setup({ entries });
  const result = (await handlers.get("session_before_compact")?.(
    {
      type: "session_before_compact",
      preparation: { tokensBefore: 12_345 },
      branchEntries: entries,
      reason: "manual",
      willRetry: false,
    },
    ctx,
  )) as { compaction?: { summary: string; firstKeptEntryId: string; tokensBefore: number; details: unknown } };

  assert.ok(result?.compaction, "必须接管压缩内容");
  const compaction = result.compaction;
  assert.equal(compaction.tokensBefore, 12_345);
  assert.equal(
    compaction.firstKeptEntryId,
    `u${10 - KEEP_RECENT_ROUNDS}`,
    `保留最近 ${KEEP_RECENT_ROUNDS} 轮 → 从 u${10 - KEEP_RECENT_ROUNDS} 开始`,
  );
  assert.match(compaction.summary, /## 1\. 用户核心意图/);
  assert.match(compaction.summary, /## 自动提取 · 修改过的文件/);
  assert.match(compaction.summary, /src\/file-0\.ts/, "自动提取的文件清单必须进摘要");
  const kept = entries.filter((entry) => entry.id === compaction.firstKeptEntryId)[0];
  assert.equal(kept.message?.role, "user");
});

test("a failed model summary still produces a usable checkpoint", async () => {
  const entries = branch(10);
  const { handlers, ctx } = setup({ entries, summarize: async () => null });
  const result = (await handlers.get("session_before_compact")?.(
    { type: "session_before_compact", preparation: { tokensBefore: 1 }, branchEntries: entries, reason: "threshold", willRetry: false },
    ctx,
  )) as { compaction?: { summary: string } };
  assert.ok(result?.compaction);
  assert.match(result.compaction.summary, /自动摘要不可用/);
  assert.match(result.compaction.summary, /src\/file-0\.ts/);
});

test("pi 算好的 preparation 优先：切点与 turnPrefix 都交给 pi", async () => {
  const entries = branch(1);
  let captured: readonly unknown[] = [];
  const { handlers, ctx } = setup({
    entries,
    summarize: async (input) => {
      captured = (input as { messages: readonly unknown[] }).messages;
      return "## 1. 用户核心意图\nok" + "y".repeat(80);
    },
  });
  const preparation = {
    firstKeptEntryId: "pi-kept-entry",
    tokensBefore: 55_555,
    previousSummary: "old checkpoint",
    isSplitTurn: true,
    messagesToSummarize: [
      { role: "user", content: [{ type: "text", text: "历史任务" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "改文件" }],
        toolCalls: [{ name: "edit", arguments: { path: "src/pi-cut.ts" } }],
      },
    ],
    turnPrefixMessages: [{ role: "user", content: [{ type: "text", text: "切分轮前半段" }] }],
  };
  const result = (await handlers.get("session_before_compact")?.(
    { type: "session_before_compact", preparation, branchEntries: entries, reason: "threshold", willRetry: false },
    ctx,
  )) as { compaction?: { summary: string; firstKeptEntryId: string; tokensBefore: number } };

  assert.ok(result?.compaction);
  // 切点必须用 pi 的，不是 PiForge 自己的轮对齐结果。
  assert.equal(result.compaction.firstKeptEntryId, "pi-kept-entry");
  assert.equal(result.compaction.tokensBefore, 55_555);
  // 摘要输入 = messagesToSummarize + turnPrefixMessages（切分轮前半段不能漏）。
  assert.equal(captured.length, 3);
  // 文件清单仍由代码兜底。
  assert.match(result.compaction.summary, /src\/pi-cut\.ts/);
});

test("falls back to pi's own summarizer when no round-aligned cut exists", async () => {
  const entries = branch(2);
  const { handlers, ctx } = setup({ entries });
  const result = await handlers.get("session_before_compact")?.(
    { type: "session_before_compact", preparation: { tokensBefore: 1 }, branchEntries: entries, reason: "manual", willRetry: false },
    ctx,
  );
  assert.equal(result, undefined, "返回 undefined → pi 用默认摘要");
});
