/**
 * Merge an orchestrator worker branch back into the parent checkout.
 *
 * worktree 隔离的代价是「成果留在另一个目录里」：worker 干完了，分支还在那儿，
 * 主干会话并不会自动看到。这里把「检查 → 合并 → 冲突回滚」做成一次可测的调用，
 * 代替此前只给模型一段让人手抄的 git 命令。
 *
 * 边界（有意为之）：
 *   1. 只做 merge，不做 rebase / squash / cherry-pick —— 需要哪种由用户决定；
 *   2. 工作区脏 → 直接拒绝（不 stash、不覆盖用户正在编辑的文件）；
 *   3. 冲突 → 自动 `merge --abort`，把仓库放回合并前的状态再报错。
 */
import { execFile } from "node:child_process";
import type { GitRunner } from "../lib/git-worktree.ts";

export type MergeBackErrorCode =
  | "E_NOT_GIT"
  | "E_DETACHED"
  | "E_DIRTY_TREE"
  | "E_NOTHING_TO_MERGE"
  | "E_CONFLICT"
  | "E_MERGE_FAILED";

export class MergeBackError extends Error {
  readonly code: MergeBackErrorCode;
  /** 冲突文件 / 脏文件列表（最多 20 条），便于用户直接处理。 */
  readonly files: string[];

  constructor(code: MergeBackErrorCode, message: string, files: string[] = []) {
    super(message);
    this.name = "MergeBackError";
    this.code = code;
    this.files = files;
  }
}

export interface MergeBackInput {
  repoRoot: string;
  branchName: string;
  message?: string;
}

export interface MergeBackDeps {
  git?: GitRunner;
}

export interface MergeBackResult {
  repoRoot: string;
  branchName: string;
  targetBranch: string;
  commit: string;
  files: string[];
}

function defaultGitRunner(args: string[], options: { cwd: string }): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd: options.cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === "number"
        ? (error as { code: number }).code
        : error
          ? 1
          : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

function lines(text: string, limit = 20): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, limit);
}

function firstLine(text: string): string {
  return lines(text, 1)[0] ?? "";
}

/** 纯逻辑部分：给定 runner 与分支，完成一次受检的 `merge --no-ff`。 */
export async function mergeOrchestratorBranch(input: MergeBackInput, deps: MergeBackDeps = {}): Promise<MergeBackResult> {
  const run = deps.git ?? defaultGitRunner;
  const cwd = input.repoRoot;
  const branchName = input.branchName.trim();
  if (!branchName) throw new MergeBackError("E_MERGE_FAILED", "branchName is empty");

  const head = await run(["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
  if (head.code !== 0) {
    throw new MergeBackError("E_NOT_GIT", `not a git checkout: ${firstLine(head.stderr) || "rev-parse failed"}`);
  }
  const targetBranch = head.stdout.trim();
  if (!targetBranch || targetBranch === "HEAD") {
    throw new MergeBackError("E_DETACHED", "the parent checkout is on a detached HEAD; check out a branch before merging");
  }

  const status = await run(["status", "--porcelain"], { cwd });
  const dirty = lines(status.stdout);
  if (dirty.length > 0) {
    throw new MergeBackError(
      "E_DIRTY_TREE",
      `the parent checkout has uncommitted changes (${dirty.length}); commit or stash them first — this tool will not touch them`,
      dirty,
    );
  }

  const pending = await run(["rev-list", "--count", branchName, "--not", targetBranch], { cwd });
  if (pending.code !== 0) {
    throw new MergeBackError("E_MERGE_FAILED", `cannot compare ${branchName} with ${targetBranch}: ${firstLine(pending.stderr)}`);
  }
  if (Number.parseInt(pending.stdout.trim() || "0", 10) === 0) {
    throw new MergeBackError(
      "E_NOTHING_TO_MERGE",
      `${branchName} has no commits that ${targetBranch} lacks (uncommitted work stays in the worker's worktree)`,
    );
  }

  const message = input.message?.trim() || `Merge orchestrator branch ${branchName}`;
  const merge = await run(["merge", "--no-ff", "-m", message, branchName], { cwd });
  if (merge.code !== 0) {
    const conflicts = lines(merge.stdout + "\n" + merge.stderr);
    // 把仓库放回合并前：冲突留给用户，不由工具猜策略。
    await run(["merge", "--abort"], { cwd });
    const isConflict = conflicts.some((line) => /CONFLICT|Automatic merge failed|needs merge/i.test(line));
    throw new MergeBackError(
      isConflict ? "E_CONFLICT" : "E_MERGE_FAILED",
      isConflict
        ? `merge conflicted and was aborted; resolve it manually between ${targetBranch} and ${branchName}`
        : `git merge failed and was aborted: ${firstLine(merge.stderr) || firstLine(merge.stdout) || "unknown error"}`,
      conflicts.slice(0, 20),
    );
  }

  const commit = await run(["rev-parse", "--short", "HEAD"], { cwd });
  const changed = await run(["diff", "--name-only", "HEAD~1", "HEAD"], { cwd });
  return {
    repoRoot: cwd,
    branchName,
    targetBranch,
    commit: commit.stdout.trim(),
    files: lines(changed.stdout, 200),
  };
}
