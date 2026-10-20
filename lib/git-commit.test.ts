import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  GitCommitError,
  commitAllChanges,
  readGitBranch,
  runGitProcess,
  type GitCommandResult,
  type GitRunner,
} from "./git-status.ts";

function fakeGit(
  responses: Array<Partial<GitCommandResult>>,
  calls: Array<{ args: string[]; cwd: string }>,
): GitRunner {
  let index = 0;
  return async (args, options) => {
    calls.push({ args, cwd: options.cwd });
    const response = responses[index] ?? {};
    index += 1;
    return { code: 0, stdout: "", stderr: "", ...response };
  };
}

test("commitAllChanges stages everything and commits with a literal message", async () => {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const runner = fakeGit(
    [
      { stdout: "/repo\n" }, // rev-parse --show-toplevel
      {}, // add -A
      {}, // commit -m
      { stdout: "abc1234\n" }, // rev-parse --short HEAD
    ],
    calls,
  );

  const result = await commitAllChanges("/repo/sub", "feat: multi tab\n\nbody", runner);
  assert.equal(result.hash, "abc1234");
  assert.deepEqual(calls[1].args, ["add", "-A"]);
  assert.deepEqual(calls[2].args, ["commit", "-m", "feat: multi tab\n\nbody"]);
  assert.deepEqual(calls[3].args, ["rev-parse", "--short", "HEAD"]);
});

test("commitAllChanges rejects an empty message before running git", async () => {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const runner = fakeGit([], calls);
  await assert.rejects(
    () => commitAllChanges("/repo", "   ", runner),
    (error: unknown) => error instanceof GitCommitError && error.code === "EMPTY_MESSAGE",
  );
  assert.equal(calls.length, 0);
});

test("commitAllChanges maps 'nothing to commit' to NOTHING_TO_COMMIT", async () => {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const runner = fakeGit(
    [
      { stdout: "/repo\n" },
      {},
      { code: 1, stdout: "On branch main\nnothing to commit, working tree clean\n" },
    ],
    calls,
  );
  await assert.rejects(
    () => commitAllChanges("/repo", "chore: nothing", runner),
    (error: unknown) => error instanceof GitCommitError && error.code === "NOTHING_TO_COMMIT",
  );
});

test("commitAllChanges surfaces git's refusal (hooks / identity) as COMMIT_FAILED", async () => {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const runner = fakeGit(
    [
      { stdout: "/repo\n" },
      {},
      { code: 1, stderr: "Author identity unknown" },
    ],
    calls,
  );
  await assert.rejects(
    () => commitAllChanges("/repo", "feat: x", runner),
    (error: unknown) =>
      error instanceof GitCommitError &&
      error.code === "COMMIT_FAILED" &&
      error.output.includes("Author identity unknown"),
  );
});

test("readGitBranch reports the branch and tolerates failure", async () => {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  assert.equal(
    await readGitBranch("/repo", fakeGit([{ stdout: "/repo\n" }, { stdout: "dev/v0.2.0\n" }], calls)),
    "dev/v0.2.0",
  );
  // Detached HEAD must not look like a branch name.
  assert.equal(
    await readGitBranch("/repo", fakeGit([{ stdout: "/repo\n" }, { stdout: "HEAD\n" }], calls)),
    null,
  );
  assert.equal(await readGitBranch("/repo", fakeGit([{ code: 128 }], calls)), null);
});

test("commitAllChanges works against a real repository", async (t) => {
  const version = await runGitProcess(["version"], { cwd: process.cwd() }).catch(() => null);
  if (!version || version.code !== 0) {
    t.skip("git is not available");
    return;
  }

  const dir = await mkdtemp(path.join(tmpdir(), "piforge-commit-"));
  try {
    await runGitProcess(["init", "-q"], { cwd: dir });
    await runGitProcess(["config", "user.email", "test@example.com"], { cwd: dir });
    await runGitProcess(["config", "user.name", "PiForge Test"], { cwd: dir });
    await writeFile(path.join(dir, "a.txt"), "hello\n", "utf8");

    const result = await commitAllChanges(dir, "feat: first commit");
    assert.ok(result.hash && /^[0-9a-f]{4,}$/.test(result.hash));

    const status = await runGitProcess(["status", "--porcelain"], { cwd: dir });
    assert.equal(status.stdout.trim(), "");

    await assert.rejects(
      () => commitAllChanges(dir, "chore: nothing"),
      (error: unknown) => error instanceof GitCommitError && error.code === "NOTHING_TO_COMMIT",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
