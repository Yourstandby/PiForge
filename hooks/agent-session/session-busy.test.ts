import test from "node:test";
import assert from "node:assert/strict";
import {
  isSessionBusyError,
  isSessionStuckError,
  promptErrorText,
  retryActionLabel,
} from "./session-busy.ts";

test("三个来源的「忙」文本都认得出来", () => {
  assert.equal(isSessionBusyError("Session is streaming"), true);
  assert.equal(isSessionBusyError("SESSION_BUSY"), true);
  assert.equal(isSessionBusyError("SESSION_STUCK: 上一轮回复已卡死"), true);
  assert.equal(isSessionBusyError("Wait for the current response to finish"), true);
  assert.equal(isSessionBusyError("HTTP 500"), false);
  assert.equal(isSessionBusyError(""), false);
  assert.equal(isSessionBusyError(null), false);
  assert.equal(isSessionBusyError(undefined), false);
});

test("只有 SESSION_STUCK 才算卡死", () => {
  assert.equal(isSessionStuckError("SESSION_STUCK"), true);
  assert.equal(isSessionStuckError("Session is streaming"), false);
  assert.equal(isSessionStuckError(null), false);
});

test("英文原文和错误码不再直接甩给用户", () => {
  assert.match(promptErrorText("Session is streaming"), /结束并重发/);
  assert.match(promptErrorText("SESSION_STUCK: ..."), /重启应用/);
  assert.equal(promptErrorText("压缩失败：disk full"), "压缩失败：disk full");
});

test("忙时按钮写「结束并重发」，否则仍是「重试」", () => {
  assert.equal(retryActionLabel("SESSION_BUSY"), "结束并重发");
  assert.equal(retryActionLabel("Session is streaming"), "结束并重发");
  assert.equal(retryActionLabel("HTTP 500"), "重试");
  assert.equal(retryActionLabel(undefined), "重试");
});
