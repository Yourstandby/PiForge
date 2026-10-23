import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPrefixSnapshot,
  diffPrefixSnapshots,
  emptyPrefixAudit,
  isExpectedPrefixChange,
  recordPrefixChange,
} from "./prompt-prefix.ts";

const ON_DEMAND = ["memory", "orchestrator"] as const;

function snapshot(tools: string[], extra?: Record<string, string>) {
  return buildPrefixSnapshot(
    { sections: { ...(extra ?? {}) }, appendSystemPrompt: "stable" },
    tools
  );
}

test("first build is not a change (a fresh session pays the write once)", () => {
  const audit = emptyPrefixAudit();
  assert.equal(audit.turns, 0);
  assert.equal(audit.unexpectedChanges, 0);
});

test("identical prefixes keep the audit stable", () => {
  const first = snapshot(["bash", "read", "shell"]);
  const diff = diffPrefixSnapshots(first, snapshot(["bash", "read", "shell"]));
  assert.equal(diff.identical, true);
  const audit = recordPrefixChange(emptyPrefixAudit(), diff, true);
  assert.equal(audit.stableTurns, 1);
  assert.equal(audit.unexpectedChanges, 0);
  assert.equal(audit.lastChange, undefined);
});

test("activating an on-demand domain is the only allowed change", () => {
  const before = snapshot(["bash", "read", "shell"]);
  const after = snapshot(["bash", "memory", "read", "shell"]);
  const diff = diffPrefixSnapshots(before, after);
  assert.equal(diff.identical, false);
  assert.equal(isExpectedPrefixChange(diff, ON_DEMAND), true, "memory is an on-demand domain");
  const audit = recordPrefixChange(emptyPrefixAudit(), diff, true);
  assert.equal(audit.expectedChanges, 1);
  assert.equal(audit.unexpectedChanges, 0);
  assert.equal(audit.lastChange?.expected, true);
  assert.deepEqual(audit.lastChange?.toolsAdded, ["memory"]);
});

test("adding an always-on tool, dropping a tool or reordering is unexpected", () => {
  const base = snapshot(["bash", "read", "shell"]);
  const addedAlwaysOn = snapshot(["bash", "browser", "read", "shell"]);
  assert.equal(isExpectedPrefixChange(diffPrefixSnapshots(base, addedAlwaysOn), ON_DEMAND), false);

  const removed = snapshot(["bash", "read"]);
  assert.equal(isExpectedPrefixChange(diffPrefixSnapshots(base, removed), ON_DEMAND), false);

  const reordered = snapshot(["bash", "read"], { b: "2" });
  assert.equal(isExpectedPrefixChange(diffPrefixSnapshots(base, reordered), ON_DEMAND), false);
});

test("changing a system prompt section without touching tools is unexpected", () => {
  const base = snapshot(["bash", "read"], { a: "1" });
  const changed = snapshot(["bash", "read"], { a: "2" });
  const diff = diffPrefixSnapshots(base, changed);
  assert.equal(diff.identical, false);
  assert.equal(isExpectedPrefixChange(diff, ON_DEMAND), false);
  const audit = recordPrefixChange(emptyPrefixAudit(), diff, false);
  assert.equal(audit.unexpectedChanges, 1);
  assert.deepEqual(audit.lastChange?.sectionsChanged.length, 1);
});

test("two on-demand domains activated at once is not the expected single activation", () => {
  const before = snapshot(["bash", "read"]);
  const after = snapshot(["bash", "memory", "orchestrator", "read"]);
  assert.equal(isExpectedPrefixChange(diffPrefixSnapshots(before, after), ON_DEMAND), false);
});
