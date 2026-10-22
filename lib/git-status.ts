import { execFile } from "node:child_process";
import { scanGitStatusInWorker } from "./git-status-worker.ts";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Minimal Git awareness for the file explorer.
 *
 * Two read-only operations, both driven by `execFile` (no shell, so paths can
 * never be interpreted as commands):
 *   - `git status --porcelain=v1 -z` → per-file change markers
 *   - `git diff HEAD -- <path>`      → the diff shown in the file viewer
 *
 * Paths are reported relative to the caller's cwd (which may be a subdirectory
 * of the repository) so the explorer can look them up directly.
 */

export interface GitCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GitRunner = (
  args: string[],
  options: { cwd: string },
) => Promise<GitCommandResult>;

export interface GitFileStatus {
  /** Path relative to the requested cwd, always "/" separated. */
  path: string;
  /** Raw two-letter porcelain code, e.g. " M", "M ", "??", "R ". */
  status: string;
  index: string;
  worktree: string;
}

export interface GitStatusResult {
  repoRoot: string;
  files: GitFileStatus[];
}

export class GitStatusError extends Error {
  readonly code: "GIT_UNAVAILABLE" | "NOT_GIT_REPOSITORY" | "PATH_OUTSIDE_CWD";

  constructor(code: GitStatusError["code"], message: string) {
    super(message);
    this.name = "GitStatusError";
    this.code = code;
  }
}

const MAX_BUFFER = 8 * 1024 * 1024;

export const runGitProcess: GitRunner = (args, { cwd }) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        windowsHide: true,
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C", LANG: "C", GIT_OPTIONAL_LOCKS: "0" },
        maxBuffer: MAX_BUFFER,
      },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          reject(
            new GitStatusError(
              "GIT_UNAVAILABLE",
              "Git is not installed or not on PATH",
            ),
          );
          return;
        }
        resolve({
          code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        });
      },
    );
  });

function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

/**
 * Parse `git status --porcelain=v1 -z` output.
 * In `-z` mode rename/copy entries are `XY <new>\0<old>\0`; we keep the new
 * path because that is what the explorer can open.
 */
export function parsePorcelainZ(stdout: string): Array<{ path: string; status: string }> {
  const parts = stdout.split("\0");
  const entries: Array<{ path: string; status: string }> = [];
  for (let i = 0; i < parts.length; i++) {
    const record = parts[i];
    if (!record || record.length < 4) continue;
    const status = record.slice(0, 2);
    const filePath = record.slice(3);
    if (!filePath) continue;
    if (status[0] === "R" || status[0] === "C") {
      // The next NUL-separated token is the original path; skip it.
      i += 1;
    }
    entries.push({ path: filePath, status });
  }
  return entries;
}

/** Resolve the repository root containing `cwd`. */
export async function resolveGitRepoRoot(
  cwd: string,
  runner: GitRunner = runGitProcess,
): Promise<string> {
  const result = await runner(["rev-parse", "--show-toplevel"], { cwd });
  const root = result.stdout.trim();
  if (result.code !== 0 || !root) {
    throw new GitStatusError("NOT_GIT_REPOSITORY", "Not a Git repository");
  }
  return path.resolve(root);
}

/** Changed files of the repository containing `cwd`, mapped back to cwd-relative paths. */
export async function readGitStatus(
  cwd: string,
  runner: GitRunner = runGitProcess,
): Promise<GitStatusResult> {
  let repoRoot: string | null = null;
  let result: GitCommandResult | null = null;

  // 默认 runner：整个 `rev-parse` + `status` 扫描进 worker，主线程不碰管道缓冲。
  // 注入 runner 的调用（测试/替身）仍走原来的内联路径。
  if (runner === runGitProcess) {
    const scanned = await scanGitStatusInWorker(cwd).catch(() => null);
    if (scanned) {
      if (!scanned.ok) {
        if (scanned.missing) throw new GitStatusError("GIT_UNAVAILABLE", "Git is not installed or not on PATH");
        throw new GitStatusError("NOT_GIT_REPOSITORY", "Not a Git repository");
      }
      repoRoot = scanned.scan.repoRoot;
      result = { code: scanned.scan.code, stdout: scanned.scan.stdout, stderr: scanned.scan.stderr };
    }
  }

  if (!repoRoot || !result) {
    repoRoot = await resolveGitRepoRoot(cwd, runner);
    result = await runner(
      // `-uall` lists untracked *files* instead of collapsing new directories
      // into a single `dir/` entry — the Git panel diffs one file at a time.
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { cwd: repoRoot },
    );
  }
  if (result.code !== 0) {
    throw new GitStatusError(
      "NOT_GIT_REPOSITORY",
      result.stderr.trim() || "git status failed",
    );
  }

  const resolvedCwd = path.resolve(cwd);
  const files: GitFileStatus[] = [];
  for (const entry of parsePorcelainZ(result.stdout)) {
    const absolute = path.resolve(repoRoot, entry.path);
    const relative = toPosix(path.relative(resolvedCwd, absolute));
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    files.push({
      path: relative,
      status: entry.status,
      index: entry.status[0] ?? " ",
      worktree: entry.status[1] ?? " ",
    });
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return { repoRoot, files };
}

function assertInsideCwd(cwd: string, target: string): string {
  const resolvedCwd = path.resolve(cwd);
  const resolvedTarget = path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(resolvedCwd, target);
  const relative = path.relative(resolvedCwd, resolvedTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new GitStatusError("PATH_OUTSIDE_CWD", "Path is outside the project");
  }
  return resolvedTarget;
}

/** Unified diff for one file. Untracked files diff against /dev/null. */
export async function readGitDiff(
  cwd: string,
  target: string,
  runner: GitRunner = runGitProcess,
): Promise<string> {
  const absolute = assertInsideCwd(cwd, target);
  const repoRoot = await resolveGitRepoRoot(cwd, runner);
  const relativeToRepo = toPosix(path.relative(repoRoot, absolute));

  const tracked = await runner(
    ["ls-files", "--error-unmatch", "--", relativeToRepo],
    { cwd: repoRoot },
  );

  if (tracked.code === 0) {
    const diff = await runner(
      ["diff", "HEAD", "--no-color", "-U3", "--", relativeToRepo],
      { cwd: repoRoot },
    );
    return diff.stdout;
  }

  // Untracked: ask git to diff "nothing" against the file. `--no-index`
  // exits 1 when files differ (expected), so the exit code is ignored.
  const untracked = await runner(
    ["diff", "--no-index", "--no-color", "-U3", "--", "/dev/null", relativeToRepo],
    { cwd: repoRoot },
  );
  if (untracked.stdout.trim()) return untracked.stdout;

  // Binary/unreadable file: still give the viewer a hint instead of a blank pane.
  const stat = await fs.stat(absolute).catch(() => null);
  if (!stat) throw new GitStatusError("PATH_OUTSIDE_CWD", "File not found");
  return `Untracked file (${stat.size} bytes) — no textual diff available.`;
}

/** Current branch name, or null when detached / unavailable. */
export async function readGitBranch(
  cwd: string,
  runner: GitRunner = runGitProcess,
): Promise<string | null> {
  try {
    const repoRoot = await resolveGitRepoRoot(cwd, runner);
    const result = await runner(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoRoot });
    const branch = result.stdout.trim();
    if (result.code !== 0 || !branch) return null;
    return branch === "HEAD" ? null : branch.slice(0, 200);
  } catch {
    return null;
  }
}

export type GitCommitErrorCode =
  | "EMPTY_MESSAGE"
  | "NOTHING_TO_COMMIT"
  | "NOT_GIT_REPOSITORY"
  | "GIT_UNAVAILABLE"
  | "COMMIT_FAILED";

export class GitCommitError extends Error {
  readonly code: GitCommitErrorCode;
  /** git's own output, shown in the panel toast so the user can act on it. */
  readonly output: string;

  constructor(code: GitCommitErrorCode, message: string, output = "") {
    super(message);
    this.name = "GitCommitError";
    this.code = code;
    this.output = output;
  }
}

export interface GitCommitResult {
  /** Short hash of the new commit, when git reported one. */
  hash: string | null;
  /** Combined stdout/stderr of `git commit`. */
  output: string;
}

export const MAX_COMMIT_MESSAGE_LENGTH = 5_000;

const NOTHING_TO_COMMIT_RE =
  /nothing to commit|nothing added to commit|no changes added to commit|nothing specified, nothing added/i;

/**
 * `git add -A` + `git commit -m <message>` in the repository containing `cwd`.
 *
 * execFile with argument arrays: the message is never interpreted by a shell.
 */
export async function commitAllChanges(
  cwd: string,
  message: string,
  runner: GitRunner = runGitProcess,
): Promise<GitCommitResult> {
  const trimmed = message.trim();
  if (!trimmed) throw new GitCommitError("EMPTY_MESSAGE", "Commit message is required");
  if (trimmed.length > MAX_COMMIT_MESSAGE_LENGTH) {
    throw new GitCommitError("EMPTY_MESSAGE", "Commit message is too long");
  }

  const repoRoot = await resolveGitRepoRoot(cwd, runner);

  const staged = await runner(["add", "-A"], { cwd: repoRoot });
  if (staged.code !== 0) {
    const output = [staged.stdout, staged.stderr].filter(Boolean).join("\n").trim();
    throw new GitCommitError("COMMIT_FAILED", output || "git add failed", output);
  }

  const committed = await runner(["commit", "-m", trimmed], { cwd: repoRoot });
  const output = [committed.stdout, committed.stderr].filter(Boolean).join("\n").trim();
  if (committed.code !== 0) {
    if (NOTHING_TO_COMMIT_RE.test(output)) {
      throw new GitCommitError("NOTHING_TO_COMMIT", "工作区没有可提交的改动", output);
    }
    throw new GitCommitError("COMMIT_FAILED", output || "git commit failed", output);
  }

  const hash = await runner(["rev-parse", "--short", "HEAD"], { cwd: repoRoot });
  return {
    hash: hash.code === 0 ? hash.stdout.trim() || null : null,
    output,
  };
}
