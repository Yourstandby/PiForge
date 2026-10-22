/**
 * 会话目录扫描的 Worker 隔离（第二部分 · 保速度）。
 *
 * `~/.pi/agent/sessions/<cwd编码>/<时间戳>_<id>.jsonl` 的扫描是 `readdir` +
 * 每个文件一次 `stat`：会话攒到几百上千个时，即便都是异步 IO，回调也全排在
 * 主线程 Event Loop 上（Node 线程池回来一次就占一次），侧栏刷新时就能看到
 * 输入延迟与掉帧。
 *
 * 这里把「两层 readdir + 全量 stat + 按 mtime 排序」整体丢进 `worker_threads`，
 * 主线程只等一条消息。任何失败（worker 不可用、超时、崩溃）都返回 null，
 * 由调用方回落到内联扫描 —— 宁可慢一点，也不让面板打不开。
 */
import { Worker } from "node:worker_threads";

const WORKER_TIMEOUT_MS = 15_000;

const WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
const { readdir, stat } = require("node:fs/promises");
const { join } = require("node:path");

async function scan(root) {
  let dirs = [];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    dirs = entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => join(root, entry.name));
  } catch {
    parentPort.postMessage({ ok: true, files: [] });
    return;
  }

  const nested = await Promise.all(
    dirs.map(async (dir) => {
      try {
        const names = await readdir(dir);
        return names.filter((name) => name.endsWith(".jsonl")).map((name) => join(dir, name));
      } catch {
        return [];
      }
    }),
  );

  const candidates = [];
  for (const list of nested) for (const path of list) candidates.push(path);

  const files = [];
  for (const path of candidates) {
    try {
      const info = await stat(path);
      files.push({ path, mtimeMs: info.mtimeMs, size: info.size });
    } catch {
      // 文件在扫描过程中被删掉：跳过。
    }
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? 1 : a.path > b.path ? -1 : 0));
  return files;
}

// 常驻 worker：一条消息一次扫描。每次新建 worker 要付 20–40ms 的启动成本，
// 侧栏每次刷新都付一遍就会变成肉眼可见的卡顿。
parentPort.on("message", async (message) => {
  const id = message && message.id;
  try {
    const files = await scan(message.root);
    parentPort.postMessage({ id, ok: true, files });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: String((error && error.message) || error) });
  }
});
`;

export interface SessionFileRefLike {
  path: string;
  mtimeMs: number;
  size: number;
}

/**
 * 常驻扫描 worker（每个进程一个）。
 * 失败 / 超时 / 崩溃都返回 null，调用方回落内联扫描 —— 宁可慢一点，也不让面板打不开。
 */
const store = globalThis as typeof globalThis & {
  __piforgeSessionScanWorker?: {
    worker: Worker | null;
    seq: number;
    pending: Map<number, (result: SessionFileRefLike[] | null) => void>;
  };
};

function state() {
  if (!store.__piforgeSessionScanWorker) {
    store.__piforgeSessionScanWorker = { worker: null, seq: 0, pending: new Map() };
  }
  return store.__piforgeSessionScanWorker;
}

function failAll(result: SessionFileRefLike[] | null): void {
  const s = state();
  const waiting = [...s.pending.values()];
  s.pending.clear();
  s.worker = null;
  for (const resolve of waiting) resolve(result);
}

function ensureWorker(): Worker | null {
  const s = state();
  if (s.worker) return s.worker;
  try {
    const worker = new Worker(WORKER_SOURCE, { eval: true });
    worker.on("message", (message: { id?: number; ok?: boolean; files?: SessionFileRefLike[] }) => {
      if (typeof message?.id !== "number") return;
      const resolve = state().pending.get(message.id);
      if (!resolve) return;
      state().pending.delete(message.id);
      resolve(message.ok && Array.isArray(message.files) ? message.files : null);
    });
    worker.on("error", () => failAll(null));
    worker.on("exit", () => failAll(null));
    // 常驻进程退出前不要拖住事件循环。
    worker.unref();
    s.worker = worker;
    return worker;
  } catch {
    return null;
  }
}

/** 在 worker 里扫描会话目录；失败返回 null，调用方自己兜底。 */
export function scanSessionDirInWorker(root: string): Promise<SessionFileRefLike[] | null> {
  const worker = ensureWorker();
  if (!worker) return Promise.resolve(null);
  const s = state();
  const id = (s.seq += 1);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!s.pending.has(id)) return;
      s.pending.delete(id);
      // 超时：worker 可能卡住，直接丢掉它，下次重建。
      void worker.terminate().catch(() => undefined);
      s.worker = null;
      resolve(null);
    }, WORKER_TIMEOUT_MS);
    s.pending.set(id, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
    try {
      worker.postMessage({ id, root });
    } catch {
      clearTimeout(timer);
      s.pending.delete(id);
      resolve(null);
    }
  });
}
