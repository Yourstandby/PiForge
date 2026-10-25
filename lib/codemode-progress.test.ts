import assert from "node:assert/strict";
import test from "node:test";
import {
  describeCodemodeFailure,
  formatCodemodeProgress,
  formatCodemodeProgressFromResult,
} from "./codemode-progress.ts";

test("a single finished call renders name, mark and duration", () => {
  assert.equal(
    formatCodemodeProgress([{ name: "bash", status: "ok", durationMs: 1234 }]),
    "bash ✓1.2s",
  );
});

test("running / error / cancelled calls are distinguishable", () => {
  assert.equal(
    formatCodemodeProgress([
      { name: "bash", status: "ok", durationMs: 1200 },
      { name: "read", status: "running" },
      { name: "edit", status: "error", durationMs: 300 },
      { name: "grep", status: "cancelled", durationMs: 50 },
    ]),
    "bash ✓1.2s · read … · edit ✗0.3s · grep ⊘0.1s",
  );
});

test("unknown status never claims success, and long durations lose the decimal", () => {
  assert.equal(formatCodemodeProgress([{ name: "web", status: "weird", durationMs: 12500 }]), "web …13s");
  assert.equal(formatCodemodeProgress([{ name: "web", status: "ok", durationMs: -1 }]), "web ✓");
});

test("more than five calls collapse into a +N tail", () => {
  const calls = Array.from({ length: 8 }, (_, index) => ({
    name: `t${index}`,
    status: "ok",
    durationMs: 100,
  }));
  assert.equal(
    formatCodemodeProgress(calls),
    "t0 ✓0.1s · t1 ✓0.1s · t2 ✓0.1s · t3 ✓0.1s · t4 ✓0.1s · … +3",
  );
});

test("empty or malformed call lists produce no line", () => {
  assert.equal(formatCodemodeProgress([]), "");
  assert.equal(formatCodemodeProgressFromResult(null), "");
  assert.equal(formatCodemodeProgressFromResult({ content: [] }), "");
  assert.equal(formatCodemodeProgressFromResult({ details: { calls: "nope" } }), "");
  assert.equal(
    formatCodemodeProgressFromResult({ content: [], details: { calls: [{ name: "bash", status: "running" }] } }),
    "bash …",
  );
});

test("timeout errors surface the held slot with the pool size", () => {
  assert.match(
    describeCodemodeFailure("Script error:\nScript timed out: Execution timed out after 30000 ms", 4) ?? "",
    /worker still exiting, slot held \(pool=4\)/,
  );
  assert.match(
    describeCodemodeFailure("Script aborted: Execution aborted", 2) ?? "",
    /worker still exiting, slot held \(pool=2\)/,
  );
});

test("queue starvation is reported separately from a timeout", () => {
  assert.match(
    describeCodemodeFailure(
      "No codemode worker became free within 60 seconds. All 2 workers, shared by every session in this process, are held by other scripts.",
      2,
    ) ?? "",
    /all codemode workers busy for 60s, script never started \(pool=2\)/,
  );
});

test("unrelated errors stay silent so the log does not fill with noise", () => {
  assert.equal(describeCodemodeFailure("Script error:\nTypeError: x is not a function", 2), null);
  assert.equal(describeCodemodeFailure("", 2), null);
});
