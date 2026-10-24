/**
 * Git 状态扫描的 Worker 隔离。
 *
 * `git status --porcelain -uall` 在大型仓库里输出可达数 MB：子进程本身是异步的，
 * 但「拼接管道输出 + 切 NUL 记录 + 逐个 resolve 路径」都在主线程，仓库一大就
 * 会拖慢 Event Loop（0.9.0 的 Next 进程里直接表现为界面卡顿）。
 *
 * 0.9.x P1-4 之后这段逻辑跑在 Agent Host 里，**改成常驻 worker**：
 * 旧实现每次扫描都 `new Worker()` + `terminate()`，实测单次多付 100–150 ms
 * （worker 启动 + V8 编译内联源码）；而 Host 的空闲 CPU 预算只有 3%，
 * 这笔固定税在 15 s 轮询下就是可观测的占用。
 *
 * 现在的形态：
 *   - 第一次扫描时懒启动一个 worker，之后所有扫描排队复用；
 *   - 每条请求带 `id`，worker 用同一个 id 回包，互不串味；
 *   - worker 异常退出 → 当前请求回 null（调用方回落到内联 execFile 路径），
 *     并把 worker 置空，下次扫描重新拉起。
 */
import { Worker } from "node:worker_threads";

const WORKER_TIMEOUT_MS = 20_000;

const WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
const { execFile } = require("node:child_process");
const MAX_BUFFER = 8 * 1024 * 1024;
const env = { ...process.env, LC_ALL: "C", LANG: "C", GIT_OPTIONAL_LOCKS: "0" };
const run = (args, dir) => new Promise((resolve) => {
  execFile("git", args, { cwd: dir, windowsHide: true, encoding: "utf8", env, maxBuffer: MAX_BUFFER },
    (error, stdout, stderr) => {
      resolve({
        code: typeof (error && error.code) === "number" ? error.code : error ? 1 : 0,
        stdout: stdout == null ? "" : stdout,
        stderr: stderr == null ? "" : stderr,
        missing: Boolean(error && error.code === "ENOENT"),
      });
    });
});
parentPort.on("message", async ({ id, cwd }) => {
  const root = await run(["rev-parse", "--show-toplevel"], cwd);
  if (root.missing) return parentPort.postMessage({ id, ok: false, missing: true });
  if (root.code !== 0 || !root.stdout.trim()) return parentPort.postMessage({ id, ok: false, notRepo: true });
  const repoRoot = root.stdout.trim();
  const status = await run(["status", "--porcelain=v1", "-z", "--untracked-files=all"], repoRoot);
  parentPort.postMessage({ id, ok: true, repoRoot, code: status.code, stdout: status.stdout, stderr: status.stderr });
});
`;

export interface GitStatusScan {
  repoRoot: string;
  code: number;
  stdout: string;
  stderr: string;
}

export type GitStatusWorkerResult =
  | { ok: true; scan: GitStatusScan }
  | { ok: false; missing: boolean; notRepo: boolean };

interface PendingScan {
  cwd: string;
  resolve: (result: GitStatusWorkerResult | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 常驻 worker + 请求队列（进程级单例）。 */
let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, PendingScan>();

function disposeWorker(): void {
  const current = worker;
  worker = null;
  if (!current) return;
  current.removeAllListeners();
  void current.terminate().catch(() => {});
  for (const [id, request] of pending) {
    clearTimeout(request.timer);
    pending.delete(id);
    request.resolve(null);
  }
}

function ensureWorker(): Worker | null {
  if (worker) return worker;
  try {
    worker = new Worker(WORKER_SOURCE, { eval: true });
  } catch {
    worker = null;
    return null;
  }
  worker.unref?.();
  worker.on("message", (message: { id?: number; ok?: boolean; missing?: boolean; notRepo?: boolean; repoRoot?: string; code?: number; stdout?: string; stderr?: string }) => {
    const id = Number(message?.id);
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    clearTimeout(request.timer);
    if (message?.ok) {
      request.resolve({
        ok: true,
        scan: {
          repoRoot: message.repoRoot ?? "",
          code: message.code ?? 0,
          stdout: message.stdout ?? "",
          stderr: message.stderr ?? "",
        },
      });
      return;
    }
    request.resolve({ ok: false, missing: Boolean(message?.missing), notRepo: Boolean(message?.notRepo) });
  });
  // worker 挂了：当前请求回 null（调用方回落），下次扫描重新拉起。
  worker.on("error", disposeWorker);
  worker.on("exit", disposeWorker);
  return worker;
}

export function scanGitStatusInWorker(cwd: string): Promise<GitStatusWorkerResult | null> {
  return new Promise((resolve) => {
    const active = ensureWorker();
    if (!active) {
      resolve(null);
      return;
    }
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(null);
    }, WORKER_TIMEOUT_MS);
    timer.unref?.();
    pending.set(id, { cwd, resolve, timer });
    active.postMessage({ id, cwd });
  });
}

/** 测试钩子：关掉常驻 worker（不参与运行时逻辑）。 */
export function resetGitStatusWorkerForTest(): void {
  disposeWorker();
}

/** 测试钩子：当前是否已有常驻 worker。 */
export function hasGitStatusWorker(): boolean {
  return worker !== null;
}
