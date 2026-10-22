/**
 * 大 JSONL 解析的 Worker 隔离。
 *
 * 会话文件超过 1MB 时，主线程 split + 逐行 JSON.parse 会长时间占住 Event Loop
 * （Electron 主进程里就是窗口掉帧、输入延迟）。这里把「读文件 + 解析」整体丢进
 * `worker_threads`，主线程只等待一条消息。
 *
 * Worker 源码内联为字符串（`eval: true`）：standalone 打包不需要额外复制文件，
 * 也不受 Next 输出目录结构影响。任何失败（worker 不可用、超时、崩溃）都回落到
 * 调用方的内联解析，绝不因为优化而让会话打不开。
 */
import { Worker } from "node:worker_threads";

/** 超过这个大小的 JSONL 才值得付 worker 启动成本。 */
export const JSONL_WORKER_THRESHOLD_BYTES = 1024 * 1024;
const WORKER_TIMEOUT_MS = 20_000;

const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { readFileSync } = require("node:fs");
const { filePath } = workerData;
try {
  const content = readFileSync(filePath, "utf8");
  const entries = [];
  let malformed = 0;
  const lines = content.split("\\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      malformed += 1;
    }
  }
  parentPort.postMessage({ ok: true, entries, malformed });
} catch (error) {
  parentPort.postMessage({ ok: false, error: String((error && error.message) || error) });
}
`;

export interface JsonlWorkerResult<T> {
  entries: T[];
  malformed: number;
}

/**
 * 在 worker 里解析一个 JSONL 文件。失败/超时返回 null，由调用方内联兜底。
 */
export function parseJsonlFileInWorker<T = unknown>(filePath: string): Promise<JsonlWorkerResult<T> | null> {
  return new Promise((resolve) => {
    let settled = false;
    let worker: Worker;
    const finish = (result: JsonlWorkerResult<T> | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker?.terminate();
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), WORKER_TIMEOUT_MS);

    try {
      worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { filePath } });
    } catch {
      clearTimeout(timer);
      settled = true;
      resolve(null);
      return;
    }
    worker.once("message", (message: { ok?: boolean; entries?: T[]; malformed?: number }) => {
      if (!message?.ok || !Array.isArray(message.entries)) {
        finish(null);
        return;
      }
      finish({ entries: message.entries, malformed: message.malformed ?? 0 });
    });
    worker.once("error", () => finish(null));
    worker.once("exit", () => finish(null));
  });
}
