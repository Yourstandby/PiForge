import test from "node:test";
import assert from "node:assert/strict";
import { describeRetryNotice, retryCauseHint, sanitizeRetryMessage } from "./retry-notice.ts";

test("no retry in flight → no notice", () => {
  assert.equal(describeRetryNotice(null), null);
  assert.equal(describeRetryNotice(undefined), null);
});

test("attempt / maxAttempts become a visible counter", () => {
  const view = describeRetryNotice({ attempt: 2, maxAttempts: 5, errorMessage: "boom" });
  assert.ok(view);
  assert.equal(view.title, "模型连接失败，正在重试（2/5）");
  assert.equal(view.detail, "boom");
});

test("a single attempt is worded as failure, not as a retry", () => {
  const view = describeRetryNotice({ attempt: 1, maxAttempts: 1 });
  assert.ok(view);
  assert.equal(view.title, "模型连接失败");
  assert.equal(view.detail, null);
  assert.equal(view.hint, null);
});

test("garbage numbers never leak into the title", () => {
  const view = describeRetryNotice({ attempt: Number.NaN, maxAttempts: -3 });
  assert.ok(view);
  assert.equal(view.title, "模型连接失败");
});

test("secrets are redacted before rendering", () => {
  const text = sanitizeRetryMessage(
    "POST /v1/chat/completions failed Authorization: Bearer abc.def.ghi key sk-1234567890abcdef",
  );
  assert.ok(text);
  assert.equal(text.includes("abc.def.ghi"), false);
  assert.equal(text.includes("1234567890abcdef"), false);
});

test("whitespace is folded and long payloads are truncated", () => {
  const text = sanitizeRetryMessage("line1\n\nline2\t\tline3");
  assert.equal(text, "line1 line2 line3");
  const long = sanitizeRetryMessage("x".repeat(1000));
  assert.ok(long);
  assert.equal(long.length, 240);
  assert.equal(long.endsWith("…"), true);
});

test("local-model connection failure maps to an actionable hint", () => {
  const view = describeRetryNotice({
    attempt: 1,
    maxAttempts: 4,
    errorMessage: "connect ECONNREFUSED 127.0.0.1:11434",
  });
  assert.ok(view?.hint);
  assert.match(view.hint, /本地模型/);
});

test("auth / model-id / rate-limit / 5xx each get their own hint", () => {
  assert.match(retryCauseHint("401 Unauthorized: invalid api key") ?? "", /API 密钥/);
  assert.match(retryCauseHint("404 model not found: gpt-x") ?? "", /模型 ID/);
  assert.match(retryCauseHint("429 rate limit exceeded") ?? "", /限流/);
  assert.match(retryCauseHint("503 service unavailable") ?? "", /暂时不可用/);
  assert.equal(retryCauseHint("something odd happened"), null);
});
