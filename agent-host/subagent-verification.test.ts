import test from "node:test";
import assert from "node:assert/strict";
import { checkSubagentVerification } from "./subagent-verification.ts";

const noTools: Array<{ name: string; detail: string }> = [];

test("accepts explicit passing test/build results", () => {
  const npm = checkSubagentVerification({
    output: "Ran `npm test`: 12 passed, 0 failed.",
    toolCalls: noTools,
  });
  assert.equal(npm.verified, true);
  assert.match(npm.reason, /通过证据/);
  assert.ok(npm.evidence.length > 0);

  const tsc = checkSubagentVerification({
    output: "tsc --noEmit: 0 errors",
    toolCalls: noTools,
  });
  assert.equal(tsc.verified, true);
});

test("marks missing or failing evidence as unverified", () => {
  const empty = checkSubagentVerification({ output: "", toolCalls: noTools });
  assert.equal(empty.verified, false);
  assert.match(empty.reason, /未找到/);

  const failing = checkSubagentVerification({
    output: "Ran npm test: 3 tests failed.",
    toolCalls: noTools,
  });
  assert.equal(failing.verified, false);
  assert.match(failing.reason, /失败证据/);

  const reportOnly = checkSubagentVerification({
    output: "The auth flow looks correct; I reviewed src/auth.ts.",
    toolCalls: noTools,
  });
  assert.equal(reportOnly.verified, false);
});

test("does not count negated or merely referenced tests as verification", () => {
  const negated = checkSubagentVerification({
    output: "I could not run tests in this read-only sub-agent; tests passed in a previous run.",
    toolCalls: noTools,
  });
  assert.equal(negated.verified, false);

  const referenceOnly = checkSubagentVerification({
    output: "Relevant coverage lives in src/auth.test.ts.",
    toolCalls: [{ name: "read", detail: "src/auth.test.ts" }],
  });
  assert.equal(referenceOnly.verified, false);
  assert.match(referenceOnly.reason, /没有执行结果/);
  assert.ok(referenceOnly.evidence.some((line) => line.includes("auth.test.ts")));
});

test("treats a test command without output as weak evidence", () => {
  const result = checkSubagentVerification({
    output: "I inspected the failing area but have no run results.",
    toolCalls: [{ name: "bash", detail: "npm test" }],
  });
  assert.equal(result.verified, false);
  assert.ok(result.evidence.some((line) => line.startsWith("command: npm test")));
});
