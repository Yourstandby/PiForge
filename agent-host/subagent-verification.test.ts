import test from "node:test";
import assert from "node:assert/strict";
import { checkSubagentVerification } from "./subagent-verification.ts";

type Call = { name: string; detail?: string; status: "running" | "ok" | "error" };
const noTools: Call[] = [];
const readOk: Call[] = [{ name: "read", detail: "src/auth.ts", status: "ok" }];

test("passing test/build text plus a successful read-only call is verified", () => {
  for (const output of ["Ran `npm test`: 12 passed, 0 failed.", "tsc --noEmit: 0 errors"]) {
    const result = checkSubagentVerification({ output, toolCalls: readOk });
    assert.equal(result.verified, true);
    assert.match(result.reason, /通过证据/);
    assert.ok(result.evidence.length > 0);
  }
});

test("text-only claims are unverified even when they say tests passed", () => {
  const npm = checkSubagentVerification({
    output: "Ran `npm test`: 12 passed, 0 failed.",
    toolCalls: noTools,
  });
  assert.equal(npm.verified, false);
  assert.match(npm.reason, /只有文本自述/);
});

test("failed or missing evidence is never verified", () => {
  const empty = checkSubagentVerification({ output: "", toolCalls: noTools });
  assert.equal(empty.verified, false);
  assert.match(empty.reason, /未找到/);

  const failing = checkSubagentVerification({
    output: "Ran npm test: 3 tests failed.",
    toolCalls: readOk,
  });
  assert.equal(failing.verified, false);
  assert.match(failing.reason, /失败证据/);

  const failedTool = checkSubagentVerification({
    output: "Ran npm test: 3 passed, 0 failed.",
    toolCalls: [{ name: "read", detail: "src/auth.ts", status: "error" }],
  });
  assert.equal(failedTool.verified, false);
  assert.match(failedTool.reason, /没有实际工具调用证据/);
});

test("does not count negated or merely referenced tests as verification", () => {
  const negated = checkSubagentVerification({
    output: "I could not run tests in this read-only sub-agent; tests passed in a previous run.",
    toolCalls: readOk,
  });
  assert.equal(negated.verified, false);

  const referenceOnly = checkSubagentVerification({
    output: "Relevant coverage lives in src/auth.test.ts.",
    toolCalls: [{ name: "read", detail: "src/auth.test.ts", status: "ok" }],
  });
  assert.equal(referenceOnly.verified, false);
  assert.match(referenceOnly.reason, /没有执行结果/);
  assert.ok(referenceOnly.evidence.some((line) => line.includes("auth.test.ts")));
});

test("shell commands alone are weak evidence", () => {
  const result = checkSubagentVerification({
    output: "I inspected the failing area but have no run results.",
    toolCalls: [{ name: "bash", detail: "npm test", status: "ok" }],
  });
  assert.equal(result.verified, false);
  assert.ok(result.evidence.some((line) => line.startsWith("command: npm test")));
});
