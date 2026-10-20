import test from "node:test";
import assert from "node:assert/strict";
import {
  PROCESS_RESTARTABLE,
  PROCESS_TRANSITIONS,
  ProcessStateError,
  assertTransition,
  canRestart,
  canTransition,
  isTerminalStatus,
  statusAfterExit,
} from "./process-state.ts";

test("state machine allows only the documented edges", () => {
  const legal: Array<[Parameters<typeof canTransition>[0], Parameters<typeof canTransition>[1]]> = [
    ["starting", "running"],
    ["starting", "stopping"],
    ["starting", "stopped"],
    ["starting", "crashed"],
    ["running", "stopping"],
    ["running", "exited"],
    ["running", "crashed"],
    ["stopping", "stopped"],
    ["stopping", "crashed"],
  ];
  for (const [from, to] of legal) {
    assert.equal(canTransition(from, to), true, `${from} → ${to} should be legal`);
    assert.doesNotThrow(() => assertTransition(from, to));
  }

  const illegal: Array<[Parameters<typeof canTransition>[0], Parameters<typeof canTransition>[1]]> = [
    ["starting", "starting"],
    ["running", "starting"],
    ["running", "running"],
    ["stopping", "running"],
    ["stopped", "running"],
    ["stopped", "stopping"],
    ["crashed", "running"],
    ["exited", "running"],
    ["exited", "stopped"],
  ];
  for (const [from, to] of illegal) {
    assert.equal(canTransition(from, to), false, `${from} → ${to} should be illegal`);
    assert.throws(() => assertTransition(from, to), ProcessStateError);
  }
});

test("terminal states never transition on their own", () => {
  for (const status of ["stopped", "crashed", "exited"] as const) {
    assert.equal(isTerminalStatus(status), true);
    assert.deepEqual(PROCESS_TRANSITIONS[status], []);
    assert.equal(canRestart(status), true);
    assert.ok(PROCESS_RESTARTABLE.includes(status));
  }
  for (const status of ["starting", "running", "stopping"] as const) {
    assert.equal(isTerminalStatus(status), false);
    assert.equal(canRestart(status), false);
  }
});

test("a requested stop wins over the exit signal (no crash, no completion)", () => {
  assert.deepEqual(statusAfterExit("stopping", null, "SIGTERM"), {
    status: "stopped",
    exitReason: "stopped",
  });
  assert.deepEqual(statusAfterExit("stopping", 130, "SIGINT"), {
    status: "stopped",
    exitReason: "stopped",
  });
});

test("natural exit is code 0 without a signal; everything else is a crash", () => {
  assert.deepEqual(statusAfterExit("running", 0, null), {
    status: "exited",
    exitReason: "natural",
  });
  assert.deepEqual(statusAfterExit("running", 1, null), {
    status: "crashed",
    exitReason: "crashed",
  });
  assert.deepEqual(statusAfterExit("running", null, "SIGSEGV"), {
    status: "crashed",
    exitReason: "crashed",
  });
  assert.deepEqual(statusAfterExit("starting", 0, null), {
    status: "exited",
    exitReason: "natural",
  });
});
