import assert from "node:assert/strict";
import { test } from "node:test";
import {
  countUserMessages,
  firstUserTextFromBranch,
  sanitizeTitle,
} from "./session-title.ts";

test("sanitizeTitle strips quotes, prefixes and trailing punctuation", () => {
  assert.equal(sanitizeTitle('Title: "修复登录问题。"'), "修复登录问题");
});

test("sanitizeTitle clamps to 15 characters", () => {
  const clamped = sanitizeTitle("这是一个非常非常非常长的会话标题内容");
  assert.ok(clamped);
  assert.equal(clamped.length, 15);
});

test("firstUserTextFromBranch and countUserMessages read message entries", () => {
  const branch = [
    { type: "message", message: { role: "user", content: "hello world" } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "second" }] } },
  ];
  assert.equal(firstUserTextFromBranch(branch), "hello world");
  assert.equal(countUserMessages(branch), 2);
});
