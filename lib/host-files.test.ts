import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentHostError } from "./agent-host-client.ts";
import { describeHostAccessDenied } from "./host-files.ts";

function denied(message: string): AgentHostError {
  return new AgentHostError({ code: "ACCESS_DENIED", message });
}

test("missing target maps to 404 and echoes the path", () => {
  const result = describeHostAccessDenied(
    denied("Path is not accessible"),
    "D:/proj/data/rag_kb/seed_patterns.json",
  );
  assert.equal(result?.status, 404);
  assert.match(result?.message ?? "", /D:\/proj\/data\/rag_kb\/seed_patterns\.json/);
});

test("missing parent directory maps to 404", () => {
  assert.equal(describeHostAccessDenied(denied("Parent directory is not accessible"))?.status, 404);
});

test("policy rejections stay 403 and keep the host reason", () => {
  const result = describeHostAccessDenied(
    denied("Path is outside the allowed roots"),
    "D:/other/a.ts",
  );
  assert.equal(result?.status, 403);
  assert.match(result?.message ?? "", /Path is outside the allowed roots/);
});

test("non-ACCESS_DENIED errors are left to the generic mapper", () => {
  assert.equal(describeHostAccessDenied(new Error("boom")), null);
  assert.equal(describeHostAccessDenied(new AgentHostError({ code: "E_TIMEOUT", message: "timeout" })), null);
});
