import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTEXT_BUDGET_RATIO,
  KEEP_RECENT_ROUNDS,
  MAX_SUMMARY_CHARS,
  MIN_ROUNDS_TO_DROP,
  assembleCompactionSummary,
  compactionSummaryInstructions,
  decideCompaction,
  extractFilePaths,
  isUsableSummary,
  planCompactionCut,
  readRoundWindow,
  serializeMessagesForSummary,
  type SessionEntryLike,
} from "./compaction-plan.ts";

/** 构造 n 轮（每轮 user + assistant）的 branch；`startId` 保证 id 唯一。 */
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
        content: [{ type: "text", text: `done ${index}` }],
        toolCalls: [{ name: "edit", arguments: { path: `src/file-${index}.ts` } }],
      },
    });
    entries.push({
      type: "message",
      id: `r${index}`,
      message: { role: "toolResult", content: [{ type: "text", text: `output ${index}` }] },
    });
  }
  return entries;
}

test("window keeps the last N rounds and reports the droppable ones", () => {
  assert.equal(KEEP_RECENT_ROUNDS, 4);
  const window = readRoundWindow(branch(9));
  assert.equal(window.roundStarts.length, 9);
  assert.equal(window.previousSummary, null);
  assert.equal(window.boundaryStart, 0);
});

test("cut always lands on a user message and keeps exactly N rounds", () => {
  const entries = branch(10);
  const cut = planCompactionCut(entries, 6);
  assert.ok(cut);
  const kept = entries.slice(cut.to).filter((entry) => entry.message?.role === "user");
  assert.equal(kept.length, 6, "保留的轮数必须正好是 6");
  assert.equal(cut.roundsDropped, 4);
  assert.equal(cut.roundsKept, 6);
  assert.equal(cut.firstKeptEntryId, entries[cut.to].id);
  assert.equal(entries[cut.to].message?.role, "user", "切点必须是用户消息，不劈轮次");
  // 被摘要的正好是切点之前的那一段
  assert.deepEqual(
    cut.messages.map((message) => message.role),
    entries.slice(cut.from, cut.to).map((entry) => entry.message?.role),
  );
  assert.equal(cut.messages.length, cut.to - cut.from);
});

test("nothing to cut when the window is not over budget", () => {
  assert.equal(planCompactionCut(branch(6), 6), null);
  assert.equal(planCompactionCut(branch(3), 6), null);
  assert.equal(planCompactionCut([], 6), null);
});

test("a previous compaction carries its summary and bounds the re-cut range", () => {
  const first = branch(10);
  const cut = planCompactionCut(first, 6);
  assert.ok(cut);
  // 真实布局：appendCompaction 把压缩条目挂到 leaf 后面 → 保留区间仍在数组里
  const compacted: SessionEntryLike[] = [
    ...first,
    {
      type: "compaction",
      id: "comp-1",
      summary: "## 1. 用户核心意图\n旧摘要",
      firstKeptEntryId: cut.firstKeptEntryId,
    },
  ];
  const window = readRoundWindow(compacted);
  assert.equal(window.previousSummary, "## 1. 用户核心意图\n旧摘要");
  assert.equal(window.roundStarts.length, 6, "压缩后只剩保留的 6 轮");
  assert.equal(
    window.boundaryStart,
    compacted.findIndex((entry) => entry.id === cut.firstKeptEntryId),
    "重压起点必须是上次保留区间的第一条",
  );

  // 再来 4 轮 → 又能压了，且摘要范围从上次的保留区间开始
  const grown = [...compacted, ...branch(4, 100)];
  const next = planCompactionCut(grown, 6);
  assert.ok(next);
  assert.equal(next.previousSummary, window.previousSummary);
  assert.equal(next.from, window.boundaryStart);
  assert.equal(next.roundsDropped, 4);
});

test("double trigger: window first, then token budget", () => {
  assert.equal(MIN_ROUNDS_TO_DROP, 3);
  assert.equal(CONTEXT_BUDGET_RATIO, 0.45);

  const windowHit = decideCompaction({
    rounds: 9,
    tokens: null,
    contextWindow: 0,
    droppableTokens: 10_000,
  });
  assert.equal(windowHit.trigger, true);
  assert.equal(windowHit.reason, "window");
  assert.equal(windowHit.droppableRounds, 9 - KEEP_RECENT_ROUNDS);

  const twoRounds = decideCompaction({
    rounds: KEEP_RECENT_ROUNDS + 2,
    tokens: null,
    contextWindow: 0,
    droppableTokens: 10_000,
  });
  assert.equal(twoRounds.trigger, false, "只攒了 2 轮不值得压一次");

  const budgetHit = decideCompaction({
    rounds: KEEP_RECENT_ROUNDS + 2,
    tokens: 150_000,
    contextWindow: 200_000,
    droppableTokens: 10_000,
  });
  assert.equal(budgetHit.trigger, true);
  assert.equal(budgetHit.reason, "budget");

  const noRoundsToDrop = decideCompaction({
    rounds: KEEP_RECENT_ROUNDS,
    tokens: 199_000,
    contextWindow: 200_000,
    droppableTokens: 10_000,
  });
  assert.equal(noRoundsToDrop.trigger, false, "没有可压的轮次就不压");

  const calm = decideCompaction({
    rounds: KEEP_RECENT_ROUNDS + 1,
    tokens: 10_000,
    contextWindow: 200_000,
    droppableTokens: 10_000,
  });
  assert.equal(calm.trigger, false);
  assert.equal(calm.reason, null);

  // 被压区间太小：压了也省不回一次摘要调用的成本，还不如不压。
  const tiny = decideCompaction({
    rounds: 20,
    tokens: 199_000,
    contextWindow: 200_000,
    droppableTokens: 800,
  });
  assert.equal(tiny.trigger, false);
  assert.equal(tiny.droppableTokens, 800);
});

test("summary instructions demand the four required sections", () => {
  const instructions = compactionSummaryInstructions();
  for (const heading of [
    "用户核心意图",
    "修改过的文件",
    "关键报错 / 事实",
    "最终决策",
  ]) {
    assert.ok(instructions.includes(heading), `缺少必需段落：${heading}`);
  }
  assert.match(instructions, /不要复述工具输出原文/);
});

test("file paths are extracted from write/read tool calls", () => {
  const result = extractFilePaths([
    {
      role: "assistant",
      toolCalls: [
        { name: "edit", arguments: { path: "src/a.ts" } },
        { name: "write", arguments: { file_path: "src/b.ts" } },
        { name: "read", arguments: { path: "src/a.ts" } },
        { name: "read", arguments: { path: "docs/readme.md" } },
        { name: "bash", arguments: { command: "ls" } },
      ],
    },
    { role: "user", content: [{ type: "text", text: "hi" }] },
  ]);
  assert.deepEqual(result.modifiedFiles, ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(result.readFiles, ["docs/readme.md"], "已修改的文件不再算只读");
});

test("assembled summary always carries the auto-extracted file list", () => {
  const raw = [
    "## 1. 用户核心意图",
    "- 把登录页改成 OAuth",
    "",
    "## 2. 修改过的文件",
    "- 见清单",
    "",
    "## 3. 关键报错 / 事实",
    "- `401 invalid_client`",
    "",
    "## 4. 最终决策",
    "- 用 next-auth",
  ].join("\n");
  const assembled = assembleCompactionSummary(raw, {
    modifiedFiles: ["src/login.tsx"],
    readFiles: ["src/env.ts"],
  });
  assert.equal(assembled.fallback, false);
  assert.match(assembled.summary, /## 自动提取 · 修改过的文件/);
  assert.match(assembled.summary, /- src\/login\.tsx/);
  assert.match(assembled.summary, /只读过（未修改）：[\s\S]*- src\/env\.ts/);
  assert.deepEqual(assembled.modifiedFiles, ["src/login.tsx"]);
});

test("a failed model summary degrades to a deterministic checkpoint", () => {
  const assembled = assembleCompactionSummary(null, { modifiedFiles: ["src/a.ts"] });
  assert.equal(assembled.fallback, true);
  assert.match(assembled.summary, /自动摘要不可用/);
  assert.match(assembled.summary, /- src\/a\.ts/);
  assert.equal(assembleCompactionSummary("too short", {}).fallback, true);
  assert.equal(isUsableSummary("x".repeat(80)), true);
  assert.equal(isUsableSummary("我无法完成这个摘要请求"), false, "太短的不算可用摘要");
  const chinese = [
    "## 1. 用户核心意图",
    "- 把登录页改成 OAuth，验收标准是三种 provider 都能登进去。",
    "## 2. 修改过的文件",
    "- src/login.tsx",
    "## 3. 关键报错 / 事实",
    "- 401 invalid_client",
    "## 4. 最终决策",
    "- 用 next-auth",
  ].join("\n");
  assert.equal(isUsableSummary(chinese), true);
});

test("an over-long model summary is capped but keeps the file list", () => {
  const raw = `## 1. 用户核心意图\n${"很长的摘要".repeat(2_000)}`;
  const assembled = assembleCompactionSummary(raw, { modifiedFiles: ["src/deep/path.ts"] });
  assert.ok(assembled.summary.length > MAX_SUMMARY_CHARS, "正文截断后仍要拼上文件段");
  assert.ok(assembled.summary.split("## 自动提取")[0].length <= MAX_SUMMARY_CHARS + 8);
  assert.match(assembled.summary, /src\/deep\/path\.ts$/);
});

test("message serialization trims per-message noise and respects the budget", () => {
  const text = serializeMessagesForSummary(
    [
      { role: "user", content: [{ type: "text", text: "build the feature" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "on it" }],
        toolCalls: [{ name: "bash", arguments: { command: "pnpm test" } }],
      },
      { role: "toolResult", content: [{ type: "text", text: "x".repeat(5_000) }] },
    ],
    2_000,
  );
  assert.match(text, /\[用户\] build the feature/);
  assert.match(text, /→ bash \{"command":"pnpm test"\}/);
  assert.ok(text.length <= 2_000 + 64);
  assert.match(text, /…$/);
});
