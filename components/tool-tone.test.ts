import assert from "node:assert/strict";
import test from "node:test";
import { toolTone } from "./tool-tone.ts";

test("每个工具固定一套色，read / write 不共用", () => {
  assert.equal(toolTone("read").text, "text-[#9A6B1F]");
  assert.equal(toolTone("write").text, "text-[#3E8A63]");
  assert.equal(toolTone("edit").text, toolTone("write").text);
  assert.notEqual(toolTone("read").text, toolTone("write").text);
});

test("大小写与别名收敛到同一套色", () => {
  assert.deepEqual(toolTone("READ"), toolTone("read"));
  assert.deepEqual(toolTone("Bash"), toolTone("bash"));
  assert.deepEqual(toolTone("pwsh"), toolTone("powershell"));
  assert.deepEqual(toolTone("cmd"), toolTone("bash"));
});

test("未知/缺失工具名走中性灰，不抛异常", () => {
  for (const name of ["grep", "", null, undefined, "mcp__x__y"]) {
    assert.equal(toolTone(name as string | null | undefined).badge, "bg-[#F4F4F5]");
  }
});
