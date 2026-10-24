import test from "node:test";
import assert from "node:assert/strict";
import { groupProcessBlocks } from "./transcript-process.ts";

const thinking = (text: string) => ({ kind: "thinking" as const, thinking: { text } });
const tool = (name: string) => ({
  kind: "tool" as const,
  tool: { block: { kind: "tool" as const, name, input: {} } },
});

test("思考与其后的工具归到同一组", () => {
  const groups = groupProcessBlocks([thinking("A"), tool("read"), tool("grep")]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].thinking?.text, "A");
  assert.deepEqual(
    groups[0].tools.map((t) => t.block.name),
    ["read", "grep"],
  );
});

test("第二段思考开启新组，工具不再串到上一组", () => {
  const groups = groupProcessBlocks([
    thinking("A"),
    tool("read"),
    thinking("B"),
    tool("edit"),
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].tools.map((t) => t.block.name), ["read"]);
  assert.equal(groups[1].thinking?.text, "B");
  assert.deepEqual(groups[1].tools.map((t) => t.block.name), ["edit"]);
});

test("没有前置思考的工具自成一组（老会话 / 直接开调）", () => {
  const groups = groupProcessBlocks([tool("bash"), tool("ls"), thinking("C"), tool("write")]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].thinking, undefined);
  assert.deepEqual(groups[0].tools.map((t) => t.block.name), ["bash", "ls"]);
  assert.equal(groups[1].thinking?.text, "C");
  assert.deepEqual(groups[1].tools.map((t) => t.block.name), ["write"]);
});

test("只有思考、没有工具时也保留该组", () => {
  const groups = groupProcessBlocks([thinking("A"), thinking("B")]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.tools.length), [0, 0]);
});

test("空输入不产生分组", () => {
  assert.deepEqual(groupProcessBlocks([]), []);
});
