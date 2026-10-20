import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeLogLine } from "./managed-processes.ts";

test("sanitizeLogLine redacts common credential shapes", () => {
  assert.equal(sanitizeLogLine("OPENAI_API_KEY=sk-abcdef123456"), "OPENAI_API_KEY=[redacted]");
  assert.equal(sanitizeLogLine("Authorization: Bearer abcdefghijklmnop"), "Authorization: Bearer [redacted]");
  assert.equal(sanitizeLogLine("token: super-secret-value"), "token: [redacted]");
  assert.equal(sanitizeLogLine("AKIAABCDEFGHIJKLMNOP"), "[redacted-aws-key]");
  assert.equal(sanitizeLogLine("ghp_abcdefghijklmnopqrst"), "[redacted-token]");
});

test("sanitizeLogLine keeps ordinary output intact", () => {
  assert.equal(sanitizeLogLine("Local: http://localhost:5173/"), "Local: http://localhost:5173/");
  assert.equal(sanitizeLogLine("compiled successfully"), "compiled successfully");
});
