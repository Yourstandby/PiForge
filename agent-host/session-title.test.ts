import assert from "node:assert/strict";
import { test } from "node:test";
import {
  countUserMessages,
  firstUserTextFromBranch,
  generateSessionTitle,
  sanitizeTitle,
  shouldAutoNameSession,
} from "./session-title.ts";

test("sanitizeTitle strips quotes, prefixes and trailing punctuation", () => {
  assert.equal(sanitizeTitle('Title: "修复登录问题。"'), "修复登录问题");
});

test("sanitizeTitle clamps to 15 characters", () => {
  const clamped = sanitizeTitle("这是一个非常非常非常长的会话标题内容");
  assert.ok(clamped);
  assert.equal(clamped.length, 15);
});

test("manual names win and only the first user turn is auto-named", () => {
  assert.equal(shouldAutoNameSession(undefined, 1), true);
  assert.equal(shouldAutoNameSession("  ", 1), true);
  assert.equal(shouldAutoNameSession("My title", 1), false);
  assert.equal(shouldAutoNameSession(undefined, 2), false);
});

test("title generation falls back to the first message when no model is set", async () => {
  const title = await generateSessionTitle(
    { model: undefined, modelRuntime: { complete: async () => { throw new Error("unused"); } } as never },
    "Fix the login redirect bug",
  );
  assert.equal(title, "Fix the login r");
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
