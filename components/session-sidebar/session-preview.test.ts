import test from "node:test";
import assert from "node:assert/strict";
import type { SessionTreeNode } from "./helpers.ts";
import { dateGroupContainsSession, dateGroupOpen, dateGroupStateKey, previewSessionGroups, SESSION_PREVIEW_LIMIT } from "./session-preview.ts";
import type { SessionDateGroup } from "./date-groups.ts";

function node(id: string, children: SessionTreeNode[] = []): SessionTreeNode {
  return {
    session: { id, path: `${id}.jsonl`, cwd: "D:/Pi", created: "2026-10-20T12:00:00.000Z", modified: "2026-10-20T12:00:00.000Z", messageCount: 1, firstMessage: id },
    children,
  };
}

function groups(spec: Array<[string, number]>): SessionDateGroup[] {
  return spec.map(([bucket, count]) => ({
    bucket: bucket as SessionDateGroup["bucket"],
    nodes: Array.from({ length: count }, (_, index) => node(`${bucket}-${index}`)),
  }));
}

test("preview keeps the newest sessions and drops empty buckets", () => {
  const preview = previewSessionGroups(groups([["today", 15], ["yesterday", 4], ["week", 9]]));
  assert.equal(preview.totalCount, 28);
  assert.equal(preview.hiddenCount, 28 - SESSION_PREVIEW_LIMIT);
  assert.deepEqual(preview.groups.map((group) => [group.bucket, group.nodes.length]), [["today", SESSION_PREVIEW_LIMIT]]);
});

test("preview spills into the next bucket when the first one is short", () => {
  const preview = previewSessionGroups(groups([["today", 2], ["yesterday", 5]]), { limit: 5 });
  assert.deepEqual(preview.groups.map((group) => [group.bucket, group.nodes.length]), [["today", 2], ["yesterday", 3]]);
  assert.equal(preview.hiddenCount, 2);
});

test("preview leaves short lists and expanded lists untouched", () => {
  const source = groups([["today", 2], ["older", 1]]);
  assert.equal(previewSessionGroups(source).groups, source);
  const long = groups([["today", 20]]);
  const expanded = previewSessionGroups(long, { expanded: true });
  assert.equal(expanded.groups, long);
  assert.equal(expanded.hiddenCount, 0);
  assert.equal(expanded.totalCount, 20);
});

test("date group open state prefers user toggles over the default", () => {
  const key = dateGroupStateKey("d:/pi", "yesterday");
  assert.equal(dateGroupOpen({}, "d:/pi", "yesterday", false), false);
  assert.equal(dateGroupOpen({}, "d:/pi", "yesterday", true), true);
  assert.equal(dateGroupOpen({ [key]: true }, "d:/pi", "yesterday", false), true);
  assert.equal(dateGroupOpen({ [key]: false }, "d:/pi", "yesterday", true), false);
  assert.equal(dateGroupOpen({ [key]: true }, "d:/other", "yesterday", false), false);
});

test("selected session forces its bucket open, including nested forks", () => {
  const nodes = [node("a", [node("a-fork")]), node("b")];
  assert.equal(dateGroupContainsSession(nodes, "a-fork"), true);
  assert.equal(dateGroupContainsSession(nodes, "b"), true);
  assert.equal(dateGroupContainsSession(nodes, "c"), false);
  assert.equal(dateGroupContainsSession(nodes, null), false);
});
