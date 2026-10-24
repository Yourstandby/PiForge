import assert from "node:assert/strict";
import test from "node:test";
import { contentToText, messageText } from "./message-content.ts";

test("string content：CustomMessage / 流式分片不再抛错", () => {
  assert.equal(contentToText("hello"), "hello");
  assert.equal(messageText({ content: "纯文本" }), "纯文本");
  assert.equal(contentToText(undefined), "");
  assert.equal(contentToText(null), "");
});

test("block 数组：只拼 text，忽略 thinking / toolCall / image", () => {
  const content = [
    { type: "thinking", text: "想一想" },
    { type: "text", text: "第一段" },
    { type: "toolCall", toolCallId: "a", toolName: "read", input: {} },
    { type: "text", text: "第二段" },
    { type: "image", data: "x", mimeType: "image/png" },
  ];
  assert.equal(contentToText(content), "第一段第二段");
  assert.equal(contentToText(content, { separator: " " }), "第一段 第二段");
});

test("脏数据：非 string 非数组、block 为 null、text 非字符串都安全", () => {
  assert.equal(contentToText(42), "");
  assert.equal(contentToText({ type: "text", text: "x" }), "");
  assert.equal(contentToText([null, { type: "text", text: 1 }, { type: "text" }]), "");
  assert.equal(messageText(null), "");
  assert.equal(messageText(undefined), "");
});
