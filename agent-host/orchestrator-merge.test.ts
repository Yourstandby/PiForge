import assert from "node:assert/strict";
import test from "node:test";
import type { GitCommandResult, GitRunner } from "../lib/git-worktree.ts";
import { MergeBackError, mergeOrchestratorBranch } from "./orchestrator-merge.ts";

type Rule = (args: string[]) => GitCommandResult | undefined;

function runner(rules: Rule[]): { git: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const git: GitRunner = async (args) => {
    calls.push(args);
    for (const rule of rules) {
      const result = rule(args);
      if (result) return result;
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { git, calls };
}

const ok = (stdout: string): GitCommandResult => ({ code: 0, stdout, stderr: "" });
const argv = (args: string[]) => args.join(" ");

const HEAD = (args: string[]) => (argv(args) === "rev-parse --abbrev-ref HEAD" ? ok("main\n") : undefined);

test("工作区脏就拒绝，绝不 stash 用户的改动", async () => {
  const { git } = runner([
    HEAD,
    (args) => (argv(args) === "status --porcelain" ? ok(" M src/app.ts\n?? notes.md\n") : undefined),
  ]);
  await assert.rejects(
    () => mergeOrchestratorBranch({ repoRoot: "/repo", branchName: "b1" }, { git }),
    (error: unknown) => error instanceof MergeBackError && error.code === "E_DIRTY_TREE" && error.files.length === 2,
  );
});

test("分支没有新提交时给出 E_NOTHING_TO_MERGE", async () => {
  const { git } = runner([
    HEAD,
    (args) => (argv(args) === "status --porcelain" ? ok("") : undefined),
    (args) => (argv(args) === "rev-list --count b1 --not main" ? ok("0\n") : undefined),
  ]);
  await assert.rejects(
    () => mergeOrchestratorBranch({ repoRoot: "/repo", branchName: "b1" }, { git }),
    (error: unknown) => error instanceof MergeBackError && error.code === "E_NOTHING_TO_MERGE",
  );
});

test("冲突后自动 merge --abort，并把仓库放回原状", async () => {
  const { git, calls } = runner([
    HEAD,
    (args) => (argv(args) === "status --porcelain" ? ok("") : undefined),
    (args) => (argv(args) === "rev-list --count b1 --not main" ? ok("2\n") : undefined),
    (args) => (args[0] === "merge" && args[1] === "--no-ff"
      ? { code: 1, stdout: "Auto-merging src/app.ts\nCONFLICT (content): Merge conflict in src/app.ts\n", stderr: "" }
      : undefined),
    (args) => (argv(args) === "merge --abort" ? ok("") : undefined),
  ]);
  await assert.rejects(
    () => mergeOrchestratorBranch({ repoRoot: "/repo", branchName: "b1" }, { git }),
    (error: unknown) => error instanceof MergeBackError && error.code === "E_CONFLICT",
  );
  assert.ok(calls.some((args) => argv(args) === "merge --abort"), "must abort the failed merge");
});

test("成功合并返回提交与文件列表", async () => {
  const { git, calls } = runner([
    HEAD,
    (args) => (argv(args) === "status --porcelain" ? ok("") : undefined),
    (args) => (argv(args) === "rev-list --count b1 --not main" ? ok("2\n") : undefined),
    (args) => (argv(args) === "rev-parse --short HEAD" ? ok("abc1234\n") : undefined),
    (args) => (argv(args) === "diff --name-only HEAD~1 HEAD" ? ok("src/a.ts\nsrc/b.ts\n") : undefined),
  ]);
  const result = await mergeOrchestratorBranch({ repoRoot: "/repo", branchName: "b1" }, { git });
  assert.equal(result.commit, "abc1234");
  assert.deepEqual(result.files, ["src/a.ts", "src/b.ts"]);
  assert.equal(result.targetBranch, "main");
  const mergeCall = calls.find((args) => argv(args).startsWith("merge --no-ff"));
  assert.ok(mergeCall, "must call merge --no-ff");
  assert.ok(mergeCall!.includes("b1"));
});

test("detached HEAD 直接拒绝", async () => {
  const { git } = runner([(args) => (argv(args) === "rev-parse --abbrev-ref HEAD" ? ok("HEAD\n") : undefined)]);
  await assert.rejects(
    () => mergeOrchestratorBranch({ repoRoot: "/repo", branchName: "b1" }, { git }),
    (error: unknown) => error instanceof MergeBackError && error.code === "E_DETACHED",
  );
});
