import test from "node:test";
import assert from "node:assert/strict";
import { buildWithTurnCache } from "./transcript-turn-cache.ts";

interface Msg {
  role: string;
  text: string;
}
interface Turn {
  messageIndex: number;
  text: string;
}

function setup() {
  const cache = new WeakMap<Msg, { refs: readonly unknown[]; turn: Turn | null }>();
  let builds = 0;
  const run = (messages: Msg[], resultRefs: Map<string, unknown>) =>
    buildWithTurnCache<Msg, Turn>(messages, cache, {
      refsOf: (message) => [resultRefs.get(message.role)],
      build: (message, index) => {
        builds += 1;
        return message.role === "skip" ? null : { messageIndex: index, text: message.text };
      },
    });
  return { run, builds: () => builds };
}

test("历史消息引用不变 → 复用同一 turn 对象（memo 才能真正跳过）", () => {
  const { run, builds } = setup();
  const a: Msg = { role: "user", text: "a" };
  const b: Msg = { role: "assistant", text: "b" };
  const first = run([a, b], new Map());
  const second = run([a, b], new Map());
  assert.equal(builds(), 2);
  assert.equal(first[0], second[0]);
  assert.equal(first[1], second[1]);
});

test("流式追加新消息：只重建新的一条，历史引用不动", () => {
  const { run, builds } = setup();
  const a: Msg = { role: "user", text: "a" };
  const b: Msg = { role: "assistant", text: "b" };
  const before = run([a], new Map());
  const c: Msg = { role: "assistant", text: "streaming" };
  const after = run([a, c], new Map());
  // 第一次构建 a，第二次只构建新追加的 c（a 原样复用）
  assert.equal(builds(), 2);
  assert.equal(before[0], after[0]);
  assert.equal(after[1]?.text, "streaming");
  assert.notEqual(b, c);
});

test("工具结果回填 → 该轮重建（不能因为消息没变就漏更新）", () => {
  const { run, builds } = setup();
  const a: Msg = { role: "tool", text: "call" };
  const empty = run([a], new Map([["tool", undefined]]));
  const withResult = run([a], new Map([["tool", { output: "done" }]]));
  assert.equal(builds(), 2);
  assert.notEqual(empty[0], withResult[0]);
});

test("下标变化但内容不变 → 新对象只改 messageIndex", () => {
  const { run } = setup();
  const a: Msg = { role: "user", text: "a" };
  const first = run([a], new Map());
  const second = run([{ role: "other", text: "prepended" }, a], new Map());
  assert.equal(second[1]?.messageIndex, 1);
  assert.equal(second[1]?.text, "a");
  assert.notEqual(first[0], second[1]);
});

test("构建出 null 的条目也被缓存（空消息不会每帧重算）", () => {
  const { run, builds } = setup();
  const skip: Msg = { role: "skip", text: "" };
  assert.equal(run([skip], new Map())[0], null);
  assert.equal(run([skip], new Map())[0], null);
  assert.equal(builds(), 1);
});
