import test from "node:test";
import assert from "node:assert/strict";
import { createFrameCoalescer, immediateScheduler, type FrameScheduler } from "./frame-coalescer.ts";

/** 手动帧调度器：测试里完全控制「什么时候到下一帧」。 */
function manualScheduler() {
  let nextHandle = 1;
  const callbacks = new Map<number, () => void>();
  const scheduler: FrameScheduler = {
    request(callback) {
      const handle = nextHandle++;
      callbacks.set(handle, callback);
      return handle;
    },
    cancel(handle) {
      callbacks.delete(handle);
    },
  };
  return {
    scheduler,
    /** 触发一帧（跑完所有已排的回调）。 */
    tick() {
      const pending = [...callbacks.entries()];
      callbacks.clear();
      for (const [, callback] of pending) callback();
    },
    get scheduled() {
      return callbacks.size;
    },
  };
}

test("同一帧内的多个快照只提交最后一次", () => {
  const frame = manualScheduler();
  const commits: number[] = [];
  const coalescer = createFrameCoalescer<number>((value) => commits.push(value), frame.scheduler);

  coalescer.push(1);
  coalescer.push(2);
  coalescer.push(3);
  assert.deepEqual(commits, [], "还没到帧尾，不提交");
  assert.equal(frame.scheduled, 1, "只排一次帧回调");

  frame.tick();
  assert.deepEqual(commits, [3], "只提交最后一次快照");
});

test("flush 立刻提交（切换 action 前用），帧回调不会重复提交", () => {
  const frame = manualScheduler();
  const commits: string[] = [];
  const coalescer = createFrameCoalescer<string>((value) => commits.push(value), frame.scheduler);

  coalescer.push("a");
  coalescer.flush();
  assert.deepEqual(commits, ["a"]);
  assert.equal(frame.scheduled, 0, "flush 必须取消已排的帧");
  frame.tick();
  assert.deepEqual(commits, ["a"]);
});

test("下一帧继续提交新值（不会被上一帧的句柄挡住）", () => {
  const frame = manualScheduler();
  const commits: number[] = [];
  const coalescer = createFrameCoalescer<number>((value) => commits.push(value), frame.scheduler);

  coalescer.push(1);
  frame.tick();
  coalescer.push(2);
  frame.tick();
  assert.deepEqual(commits, [1, 2]);
});

test("dispose 之后不再提交", () => {
  const frame = manualScheduler();
  const commits: number[] = [];
  const coalescer = createFrameCoalescer<number>((value) => commits.push(value), frame.scheduler);

  coalescer.push(1);
  coalescer.dispose();
  frame.tick();
  coalescer.push(2);
  frame.tick();
  assert.deepEqual(commits, []);
});

test("无 rAF 环境退化为同步提交（node 里不会丢最后一个 token）", () => {
  const commits: number[] = [];
  const coalescer = createFrameCoalescer<number>((value) => commits.push(value), immediateScheduler);
  coalescer.push(7);
  assert.deepEqual(commits, [7]);
  assert.equal(coalescer.pending, false);
});
