"use client";

/**
 * 空闲调度器（渲染进程侧）。
 *
 * 约定（阶段八 · 性能铁律）：
 *   1. 后台任务只在浏览器空闲时跑（`requestIdleCallback`，无则下一个宏任务）；
 *   2. **并发数恒为 1** —— 同一时刻最多一个后台任务，避免互相抢占；
 *   3. **2 秒硬超时** —— 超时就放弃这次任务，绝不拖住用户交互。
 *
 * 用于：缓存预热、下一页会话预取、语法高亮等「不做也不影响功能」的工作。
 */

const DEFAULT_TIMEOUT_MS = 2_000;

type Task = () => void | Promise<void>;

const queue: Task[] = [];
let running = false;

function runNext(): void {
  if (running) return;
  const task = queue.shift();
  if (!task) return;
  running = true;

  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    running = false;
    runNext();
  };
  // 硬超时：任务自己不返回也强行让出槽位（任务内部应自行处理中途退出）。
  const timer = setTimeout(finish, DEFAULT_TIMEOUT_MS);

  const run = () => {
    try {
      const result = task();
      if (result && typeof (result as Promise<void>).then === "function") {
        void (result as Promise<void>).then(
          () => {
            clearTimeout(timer);
            finish();
          },
          () => {
            clearTimeout(timer);
            finish();
          },
        );
        return;
      }
      clearTimeout(timer);
      finish();
    } catch {
      clearTimeout(timer);
      finish();
    }
  };

  if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(run, { timeout: DEFAULT_TIMEOUT_MS });
    return;
  }
  setTimeout(run, 0);
}

/** 排队一个空闲任务（并发 1，2s 超时）。返回取消函数（排队中才有效）。 */
export function scheduleIdleTask(task: Task): () => void {
  queue.push(task);
  runNext();
  return () => {
    const index = queue.indexOf(task);
    if (index >= 0) queue.splice(index, 1);
  };
}
