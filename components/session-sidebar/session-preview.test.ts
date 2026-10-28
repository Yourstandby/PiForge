import test from "node:test";
import assert from "node:assert/strict";
import type { SessionTreeNode } from "./helpers.ts";
import { dateGroupContainsSession, dateGroupOpen, dateGroupOpenByDefault, dateGroupStateKey } from "./session-preview.ts";

function node(id: string, children: SessionTreeNode[] = []): SessionTreeNode {
  return {
    session: { id, path: `${id}.jsonl`, cwd: "D:/Pi", created: "2026-10-20T12:00:00.000Z", modified: "2026-10-20T12:00:00.000Z", messageCount: 1, firstMessage: id },
    children,
  };
}

test("date group open state prefers user toggles over the default", () => {
  const key = dateGroupStateKey("d:/pi", "yesterday");
  assert.equal(dateGroupOpen({}, "d:/pi", "yesterday", false), false);
  assert.equal(dateGroupOpen({}, "d:/pi", "yesterday", true), true);
  assert.equal(dateGroupOpen({ [key]: true }, "d:/pi", "yesterday", false), true);
  assert.equal(dateGroupOpen({ [key]: false }, "d:/pi", "yesterday", true), false);
  assert.equal(dateGroupOpen({ [key]: true }, "d:/other", "yesterday", false), false);
});

test("only today and yesterday open by default", () => {
  assert.equal(dateGroupOpenByDefault("today"), true);
  assert.equal(dateGroupOpenByDefault("yesterday"), true);
  assert.equal(dateGroupOpenByDefault("week"), false);
  assert.equal(dateGroupOpenByDefault("m:2026-10"), false);
  assert.equal(dateGroupOpenByDefault("y:2025"), false);
  assert.equal(dateGroupOpenByDefault("unknown"), false);
});

test("selected session forces its bucket open, including nested forks", () => {
  const nodes = [node("a", [node("a-fork")]), node("b")];
  assert.equal(dateGroupContainsSession(nodes, "a-fork"), true);
  assert.equal(dateGroupContainsSession(nodes, "b"), true);
  assert.equal(dateGroupContainsSession(nodes, "c"), false);
  assert.equal(dateGroupContainsSession(nodes, null), false);
});
