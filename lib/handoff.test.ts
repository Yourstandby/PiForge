import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildHandoffBlock, findHandoffFile, HANDOFF_MAX_CHARS } from "./handoff.ts";

function box() {
  return mkdtempSync(join(tmpdir(), "piforge-handoff-"));
}

test("没有交接文件时返回 null（不注入）", () => {
  const cwd = box();
  assert.equal(findHandoffFile(cwd), null);
  assert.equal(buildHandoffBlock(cwd), null);
});

test("根目录 HANDOFF.md 优先于 docs/", () => {
  const cwd = box();
  mkdirSync(join(cwd, "docs"));
  writeFileSync(join(cwd, "docs", "HANDOFF.md"), "docs 版本");
  writeFileSync(join(cwd, "HANDOFF.md"), "根目录版本");
  assert.equal(findHandoffFile(cwd), join(cwd, "HANDOFF.md"));
  assert.match(buildHandoffBlock(cwd) ?? "", /根目录版本/);
});

test("空文件不注入", () => {
  const cwd = box();
  writeFileSync(join(cwd, "HANDOFF.md"), "   \n\n ");
  assert.equal(buildHandoffBlock(cwd), null);
});

test("超长内容截断并提示用 read 看全文", () => {
  const cwd = box();
  writeFileSync(join(cwd, "HANDOFF.md"), "x".repeat(HANDOFF_MAX_CHARS + 500));
  const block = buildHandoffBlock(cwd) ?? "";
  assert.ok(block.includes("已截断"));
  assert.ok(block.length < HANDOFF_MAX_CHARS + 600);
});

test("块内明确标注「不是用户指令」", () => {
  const cwd = box();
  writeFileSync(join(cwd, "HANDOFF.md"), "改了什么：无");
  const block = buildHandoffBlock(cwd) ?? "";
  assert.match(block, /不是新的用户指令/);
  assert.match(block, /以本轮为准/);
});
