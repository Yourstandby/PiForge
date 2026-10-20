import test from "node:test";
import assert from "node:assert/strict";
import type { SessionBranchNode } from "@contract/domains/sessions";
import { buildBranchSwitchMap } from "./session-branches-view.ts";

function node(
  id: string,
  parentId: string | null,
  kind: SessionBranchNode["kind"] = "user",
  leafId = id,
): SessionBranchNode {
  return {
    id,
    parentId,
    kind,
    leafId,
    timestamp: "2026-01-01T00:00:00.000Z",
    label: id,
    childCount: 0,
  };
}

test("no switcher for a linear conversation", () => {
  const map = buildBranchSwitchMap([
    node("u1", null, "user", "a1"),
    node("a1", "u1", "assistant", "a1"),
  ]);
  assert.equal(map.size, 0);
});

test("sibling user prompts share one 1/2 switcher pointing at each subtree leaf", () => {
  const map = buildBranchSwitchMap([
    node("u1", null, "user", "a3"),
    node("a1", "u1", "assistant", "a3"),
    node("u2", "a1", "user", "a2"),
    node("a2", "u2", "assistant", "a2"),
    node("u3", "a1", "user", "a3"),
    node("a3", "u3", "assistant", "a3"),
  ]);

  const second = map.get("u2");
  assert.ok(second);
  assert.equal(second.index, 0);
  assert.equal(second.total, 2);
  assert.deepEqual(second.targets, [
    { nodeId: "u2", leafId: "a2" },
    { nodeId: "u3", leafId: "a3" },
  ]);

  const alternative = map.get("u3");
  assert.equal(alternative?.index, 1);
  assert.equal(alternative?.total, 2);

  // Assistant replies under each prompt are not themselves branch points.
  assert.equal(map.has("a2"), false);
  assert.equal(map.has("a3"), false);
});

test("tool entries never produce switchers", () => {
  const map = buildBranchSwitchMap([
    node("u1", null, "user", "t1"),
    node("t1", "u1", "tool", "t1"),
    node("a1", "t1", "assistant", "a1"),
  ]);
  assert.equal(map.size, 0);
});
