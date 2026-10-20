import test from "node:test";
import assert from "node:assert/strict";
import type { SessionTreeNode } from "./helpers.ts";
import { groupSessionNodesByDate, sessionDateBucket } from "./date-groups.ts";

function node(id: string, modified: string): SessionTreeNode {
  return {
    session: {
      id,
      path: `${id}.jsonl`,
      cwd: "D:/Pi",
      created: modified,
      modified,
      messageCount: 1,
      firstMessage: id,
    },
    children: [],
  };
}

const NOW = new Date(2026, 9, 20, 12, 0, 0).getTime();
function at(daysAgo: number, hour = 12): string {
  return new Date(2026, 9, 20 - daysAgo, hour, 0, 0).toISOString();
}

test("date buckets use local calendar days", () => {
  assert.equal(sessionDateBucket(at(0, 0), NOW), "today");
  assert.equal(sessionDateBucket(at(1, 23), NOW), "yesterday");
  assert.equal(sessionDateBucket(at(3), NOW), "week");
  assert.equal(sessionDateBucket(at(10), NOW), "month");
  assert.equal(sessionDateBucket(at(40), NOW), "older");
  assert.equal(sessionDateBucket("not-a-date", NOW), "older");
});

test("date grouping keeps sorted roots contiguous and preserves children", () => {
  const roots = [node("today-a", at(0)), node("today-b", at(0, 9)), node("week", at(3)), node("old", at(90))];
  const groups = groupSessionNodesByDate(roots, NOW);
  assert.deepEqual(groups.map((group) => group.bucket), ["today", "week", "older"]);
  assert.deepEqual(groups[0].nodes.map((item) => item.session.id), ["today-a", "today-b"]);
  assert.equal(groups[2].nodes[0].session.id, "old");
  assert.equal(groups[0].nodes[0].children.length, 0);
});
