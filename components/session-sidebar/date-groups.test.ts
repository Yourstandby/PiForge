import test from "node:test";
import assert from "node:assert/strict";
import type { SessionTreeNode } from "./helpers.ts";
import { formatDateBucketLabel, groupSessionNodesByDate, sessionDateBucket } from "./date-groups.ts";

function node(id: string, modified: string, children: SessionTreeNode[] = []): SessionTreeNode {
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
    children,
  };
}

const NOW = new Date(2026, 9, 20, 12, 0, 0).getTime();
function at(daysAgo: number, hour = 12): string {
  return new Date(2026, 9, 20 - daysAgo, hour, 0, 0).toISOString();
}

test("date buckets decay: days -> months -> years", () => {
  assert.equal(sessionDateBucket(at(0, 0), NOW), "today");
  assert.equal(sessionDateBucket(at(1, 23), NOW), "yesterday");
  assert.equal(sessionDateBucket(at(6), NOW), "week");
  assert.equal(sessionDateBucket(at(7), NOW), "m:2026-10");
  assert.equal(sessionDateBucket(at(40), NOW), "m:2026-09");
  assert.equal(sessionDateBucket(at(400), NOW), "y:2025");
  assert.equal(sessionDateBucket("not-a-date", NOW), "unknown");
});

test("grouping never trims: counts sum to the input and match nodes", () => {
  const roots = [node("a", at(0)), node("b", at(0, 9)), node("c", at(3)), node("d", at(90)), node("e", at(400))];
  const groups = groupSessionNodesByDate(roots, NOW);
  assert.deepEqual(groups.map((group) => group.bucket), ["today", "week", "m:2026-07", "y:2025"]);
  assert.equal(groups.reduce((sum, group) => sum + group.count, 0), roots.length);
  for (const group of groups) assert.equal(group.count, group.nodes.length);
});

test("counts only root sessions; forks living under a parent are not double counted", () => {
  const roots = [node("a", at(0), [node("a-fork", at(0)), node("a-fork-2", at(0))])];
  const groups = groupSessionNodesByDate(roots, NOW);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].count, 1);
  assert.equal(groups[0].nodes[0].children.length, 2);
});

test("unparsable timestamps land in unknown and stay last", () => {
  const roots = [node("bad", "not-a-date"), node("a", at(0)), node("b", at(400))];
  const groups = groupSessionNodesByDate(roots, NOW);
  assert.deepEqual(groups.map((group) => group.bucket), ["today", "y:2025", "unknown"]);
});

test("month and year labels follow the locale", () => {
  assert.equal(formatDateBucketLabel("m:2026-10", "zh-CN"), "2026年10月");
  assert.equal(formatDateBucketLabel("m:2026-10", "en"), "Oct 2026");
  assert.equal(formatDateBucketLabel("y:2025", "zh-CN"), "2025年");
  assert.equal(formatDateBucketLabel("y:2025", "en"), "2025");
  assert.equal(formatDateBucketLabel("today", "zh-CN"), null);
});
