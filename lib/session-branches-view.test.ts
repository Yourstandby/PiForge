import test from "node:test";
import assert from "node:assert/strict";
import type { SessionBranchNode } from "@contract/domains/sessions";
import {
  branchNodesToTree,
  buildBranchSwitchMap,
  hasBranchPoint,
  rootTreesOf,
  VIRTUAL_ROOT_ID,
} from "./session-branches-view.ts";

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

test("the navigator tree keeps sibling branches that data.tree drops", () => {
  const nodes = [
    node("u1", null, "user", "a3"),
    node("a1", "u1", "assistant", "a3"),
    node("u2", "a1", "user", "a2"),
    node("a2", "u2", "assistant", "a2"),
    node("u3", "a1", "user", "a3"),
    node("a3", "u3", "assistant", "a3"),
  ];
  const roots = branchNodesToTree(nodes);

  assert.equal(roots.length, 1);
  assert.equal(roots[0].entry.id, "u1");
  const branchPoint = roots[0].children[0];
  assert.equal(branchPoint.entry.id, "a1");
  // 两个 user 兄弟都在树里 —— 这正是「当前会话没有分支」误报的根源。
  assert.equal(branchPoint.children.length, 2);
  assert.deepEqual(branchPoint.children.map((child) => child.entry.id), ["u2", "u3"]);
  assert.deepEqual(branchPoint.children.map((child) => child.label), ["u2", "u3"]);
  // 点中一行要切到该节点子树的最深叶，而不是节点本身。
  assert.deepEqual(branchPoint.children.map((child) => child.leafId), ["a2", "a3"]);
});

test("multi-root graphs (session / model_change entries) still expose their branch", () => {
  // 真实的 pi 会话文件：session 与 model_change 条目都是 parentId=null 的根，
  // 分叉挂在第二个根下面。只取 tree[0] 就会误报「当前会话没有分支」。
  const tree = branchNodesToTree([
    node("s1", null, "other", "s1"),
    node("m1", null, "other", "a2"),
    node("u1", "m1", "user", "a2"),
    node("a1", "u1", "assistant", "a2"),
    node("u2", "u1", "user", "a2"),
  ]);

  assert.equal(tree.length, 2);
  assert.equal(hasBranchPoint(tree), true);

  // 空壳的 session 根被剔除，真正承载分叉的 model_change 根成为唯一渲染入口。
  const roots = rootTreesOf(tree);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].entry.id, "m1");
  const branchPoint = roots[0].children[0];
  assert.equal(branchPoint.entry.id, "u1");
  assert.equal(branchPoint.children.length, 2);
});

test("several path-carrying roots are merged under one virtual root", () => {
  const tree = branchNodesToTree([
    node("m1", null, "other", "a1"),
    node("u1", "m1", "user", "a1"),
    node("a1", "u1", "assistant", "a1"),
    node("m2", null, "other", "a2"),
    node("u2", "m2", "user", "a2"),
    node("a2", "u2", "assistant", "a2"),
  ]);
  assert.equal(tree.length, 2);
  // 两个根各自只有单链：根层并列本身就是唯一的分叉，必须合成虚拟根。
  assert.equal(hasBranchPoint(tree), true);

  const merged = rootTreesOf(tree);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].entry.id, VIRTUAL_ROOT_ID);
  assert.deepEqual(merged[0].children.map((child) => child.entry.id), ["m1", "m2"]);
});

test("rootTreesOf leaves single-root trees untouched and reports no branch", () => {
  const tree = branchNodesToTree([
    node("u1", null, "user", "a1"),
    node("a1", "u1", "assistant", "a1"),
  ]);
  assert.equal(rootTreesOf(tree), tree);
  assert.equal(hasBranchPoint(tree), false);
});

test("orphan nodes (parent outside the window) still render as roots", () => {
  const roots = branchNodesToTree([node("u1", "missing-parent", "user", "a1")]);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].entry.parentId, "missing-parent");
  assert.equal(branchNodesToTree([]).length, 0);
});

test("tool entries never produce switchers", () => {
  const map = buildBranchSwitchMap([
    node("u1", null, "user", "t1"),
    node("t1", "u1", "tool", "t1"),
    node("a1", "t1", "assistant", "a1"),
  ]);
  assert.equal(map.size, 0);
});
