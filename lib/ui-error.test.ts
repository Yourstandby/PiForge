import assert from "node:assert/strict";
import test from "node:test";
import {
  diagnosticsEnabled,
  isHostTransportError,
  visibleErrorMessage,
} from "./ui-error.ts";

test("agent host pipe errors are classified as transport noise", () => {
  for (const message of [
    String.raw`connect ENOENT \\.\pipe\piforge-agent-9f2c4d`,
    "Error: connect ECONNREFUSED 127.0.0.1:30141",
    "socket hang up",
    "Agent Host client is closed",
  ]) {
    assert.equal(isHostTransportError(message), true, message);
  }
});

test("real user-facing errors are kept", () => {
  for (const message of [
    "读取目录失败（HTTP 403）",
    "路径不在允许范围内",
    "Git 未安装",
  ]) {
    assert.equal(isHostTransportError(message), false, message);
    assert.equal(visibleErrorMessage(message), message);
  }
});

test("transport noise never reaches the UI outside development", () => {
  const env = process.env as Record<string, string | undefined>;
  const previous = env.NODE_ENV;
  env.NODE_ENV = "production";
  try {
    assert.equal(diagnosticsEnabled(), false);
    assert.equal(visibleErrorMessage(String.raw`connect ENOENT \\.\pipe\piforge-agent-x`), null);
    assert.equal(visibleErrorMessage("路径不在允许范围内"), "路径不在允许范围内");
  } finally {
    env.NODE_ENV = previous;
  }
});

test("empty and whitespace messages render nothing", () => {
  assert.equal(visibleErrorMessage(""), null);
  assert.equal(visibleErrorMessage("   "), null);
  assert.equal(visibleErrorMessage(null), null);
  assert.equal(visibleErrorMessage(undefined), null);
});
