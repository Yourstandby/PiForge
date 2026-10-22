/**
 * Git 状态扫描的 Worker 隔离。
 *
 * `git status --porcelain -uall` 在大型仓库里输出可达数 MB：子进程本身是异步的，
 * 但「拼接管道输出 + 切 NUL 记录 + 逐个 resolve 路径」都在主线程，仓库一大就
 * 会拖慢 Event Loop（Electron 主进程里直接表现为界面卡顿）。
 *
 * 这里把 `git rev-parse` + `git status` 的执行和分片放进 worker；主线程只做
 * 便宜的 cwd 相对路径换算。worker 不可用时调用方回落到原生 `execFile` 路径。
 */
import { Worker } from "node:worker_threads";

const WORKER_TIMEOUT_MS = 20_000;

const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { execFile } = require("node:child_process");
const { cwd } = workerData;
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
(async () => {
  const root = await run(["rev-parse", "--show-toplevel"], cwd);
  if (root.missing) return parentPort.postMessage({ ok: false, missing: true });
  if (root.code !== 0 || !root.stdout.trim()) return parentPort.postMessage({ ok: false, notRepo: true });
  const repoRoot = root.stdout.trim();
  const status = await run(["status", "--porcelain=v1", "-z", "--untracked-files=all"], repoRoot);
  parentPort.postMessage({ ok: true, repoRoot, code: status.code, stdout: status.stdout, stderr: status.stderr });
})();
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

export function scanGitStatusInWorker(cwd: string): Promise<GitStatusWorkerResult | null> {
  return new Promise((resolve) => {
    let settled = false;
    let worker: Worker;
    const finish = (result: GitStatusWorkerResult | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker?.terminate();
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), WORKER_TIMEOUT_MS);

    try {
      worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { cwd } });
    } catch {
      clearTimeout(timer);
      settled = true;
      resolve(null);
      return;
    }
    worker.once("message", (message: { ok?: boolean; missing?: boolean; notRepo?: boolean; repoRoot?: string; code?: number; stdout?: string; stderr?: string }) => {
      if (message?.ok) {
        finish({
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
      finish({ ok: false, missing: Boolean(message?.missing), notRepo: Boolean(message?.notRepo) });
    });
    worker.once("error", () => finish(null));
    worker.once("exit", () => finish(null));
  });
}
