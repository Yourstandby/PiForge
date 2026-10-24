import assert from "node:assert/strict";
import test from "node:test";
import { mergeBackHint } from "./desktop-orchestrator-extension.ts";

const TASK = {
  repoRoot: "/repo",
  cwd: "/worktrees/repo-abc12345",
  branchName: "piforge/orchestrator-abc12345",
  status: "finished",
};

test("merge-back hint gives read-only inspection before the merge command", () => {
  const hint = mergeBackHint(TASK);
  assert.ok(hint);
  const lines = hint!.split("\n");
  assert.match(lines[0], /Merge back/);
  assert.match(hint!, /git -C \/repo log --oneline piforge\/orchestrator-abc12345 --not HEAD/);
  assert.match(hint!, /git -C \/repo diff HEAD\.\.\.piforge\/orchestrator-abc12345 --stat/);
  assert.match(hint!, /git -C \/repo merge --no-ff piforge\/orchestrator-abc12345/);
  // 未提交的活只在 worktree 里，这一条必须出现，否则主干会以为全合完了。
  assert.match(hint!, /git -C \/worktrees\/repo-abc12345 diff/);
});

test("a still-running worker is announced as such", () => {
  const hint = mergeBackHint({ ...TASK, status: "running" });
  assert.ok(hint);
  assert.match(hint!, /still running/);
});

test("paths with spaces are quoted so the commands are copy-pasteable", () => {
  const hint = mergeBackHint({
    ...TASK,
    repoRoot: "C:\\Users\\Luo Wei\\proj",
    cwd: "C:\\Users\\Luo Wei\\proj-wt",
    branchName: "piforge/one",
  });
  assert.ok(hint);
  assert.match(hint!, /git -C "C:\\Users\\Luo Wei\\proj" log/);
  assert.match(hint!, /git -C "C:\\Users\\Luo Wei\\proj-wt" diff/);
  // 无空格的分支名不加引号
  assert.match(hint!, /--not HEAD/);
});

test("no hint without a worktree repo or branch", () => {
  assert.equal(mergeBackHint({ ...TASK, repoRoot: null }), null);
  assert.equal(mergeBackHint({ ...TASK, branchName: null }), null);
  assert.equal(mergeBackHint({ ...TASK, repoRoot: "" }), null);
});
