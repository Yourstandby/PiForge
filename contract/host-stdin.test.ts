import test from "node:test";
import assert from "node:assert/strict";
import { hostShutdownFrame, parseHostStdinLine } from "./host-stdin.ts";

test("hostShutdownFrame: 单行 JSON + 换行，可被 parseHostStdinLine 读回", () => {
  const frame = hostShutdownFrame();
  assert.equal(frame.endsWith("\n"), true);
  assert.equal(frame.split("\n").length, 2);
  assert.deepEqual(parseHostStdinLine(frame), { type: "shutdown", reason: "app-quit" });
});

test("hostShutdownFrame: 自定义 reason 透传", () => {
  assert.deepEqual(parseHostStdinLine(hostShutdownFrame("before-quit")), {
    type: "shutdown",
    reason: "before-quit",
  });
});

test("parseHostStdinLine: 空行/非 JSON/其它 type 一律忽略（不能误关 host）", () => {
  for (const line of ["", "   ", "not json", "{}", '{"type":"ping"}', "null", '["shutdown"]']) {
    assert.equal(parseHostStdinLine(line), null, `line=${JSON.stringify(line)}`);
  }
});

test("parseHostStdinLine: reason 非字符串时不带 reason 字段", () => {
  assert.deepEqual(parseHostStdinLine('{"type":"shutdown","reason":42}'), { type: "shutdown" });
});

test("parseHostStdinLine: 容错前后空白", () => {
  assert.deepEqual(parseHostStdinLine('  {"type":"shutdown"}  \r\n'), { type: "shutdown" });
});
