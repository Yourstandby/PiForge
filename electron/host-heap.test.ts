import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_HOST_HEAP,
  TIGHT_HOST_HEAP,
  isHeapExhaustion,
  resolveHostHeapFlags,
} from "./host-heap.ts";

test("默认档：8 / 256（30 轮 soak 前的保守值）", () => {
  const flags = resolveHostHeapFlags({ env: {} });
  // js-flags 只带老生代（新生代由 host 运行时补，见 host-heap.ts 注释）
  assert.deepEqual(flags.execArgv, ["--js-flags=--max-old-space-size=256"]);
  assert.equal(flags.semiSpaceMb, 8, "semi 仍然要报告出去（main 会写进 host 环境）");
  assert.equal(flags.semiSpaceMb, 8);
  assert.equal(flags.oldSpaceMb, 256);
  assert.match(flags.reason, /default/);
  assert.equal(DEFAULT_HOST_HEAP.maxOldSpaceSizeMb, 256);
});

test("PIFORGE_HOST_HEAP=default 不加任何堆参数（回退用）", () => {
  const flags = resolveHostHeapFlags({ env: { PIFORGE_HOST_HEAP: "default" } });
  assert.deepEqual(flags.execArgv, []);
  assert.equal(flags.semiSpaceMb, null);
  assert.equal(flags.oldSpaceMb, null);
  assert.match(flags.reason, /回退/);
  assert.deepEqual(resolveHostHeapFlags({ env: { PIFORGE_HOST_HEAP: "0" } }).execArgv, []);
});

test("自定义：semi=4,old=192；只写一项时另一项保持默认", () => {
  assert.deepEqual(resolveHostHeapFlags({ env: { PIFORGE_HOST_HEAP: "semi=4,old=192" } }).execArgv, [
    "--js-flags=--max-old-space-size=192",
  ]);
  assert.deepEqual(resolveHostHeapFlags({ env: { PIFORGE_HOST_HEAP: "old=192" } }).execArgv, [
    "--js-flags=--max-old-space-size=192",
  ]);
  const semiOnly = resolveHostHeapFlags({ env: { PIFORGE_HOST_HEAP: "semi=16" } });
  assert.deepEqual(semiOnly.execArgv, ["--js-flags=--max-old-space-size=256"]);
  assert.equal(semiOnly.semiSpaceMb, 16);
});

test("无法解析的值不会静默改行为：保持默认并说明", () => {
  const flags = resolveHostHeapFlags({ env: { PIFORGE_HOST_HEAP: "wat" } });
  // js-flags 只带老生代（新生代由 host 运行时补，见 host-heap.ts 注释）
  assert.deepEqual(flags.execArgv, ["--js-flags=--max-old-space-size=256"]);
  assert.equal(flags.semiSpaceMb, 8, "semi 仍然要报告出去（main 会写进 host 环境）");
  assert.match(flags.reason, /无法解析/);
});

test("非法数值（0 / 负数 / NaN）被忽略，不会生成 --max-*-size=NaN", () => {
  assert.deepEqual(resolveHostHeapFlags({ env: { PIFORGE_HOST_HEAP: "semi=0,old=abc" } }).execArgv, [
    "--js-flags=--max-old-space-size=256",
  ]);
  for (const argv of [
    resolveHostHeapFlags({ env: { PIFORGE_HOST_HEAP: "semi=-4" } }).execArgv,
    resolveHostHeapFlags({ env: { PIFORGE_HOST_HEAP: "old=NaN" } }).execArgv,
  ]) {
    for (const flag of argv) {
      // 只允许 `--js-flags=` + 形如 `--max-*-space-size=<正整数>` 的内容
      assert.match(flag, /^--js-flags=--max-(semi|old)-space-size=\d+$/);
    }
  }
});

test("额外参数（--cpu-prof）拼在堆参数之后，且不覆盖堆参数", () => {
  const flags = resolveHostHeapFlags({ env: {}, extraFlags: ["--cpu-prof", "--cpu-prof-dir", "C:/tmp"] });
  assert.deepEqual(flags.execArgv[0], "--js-flags=--max-old-space-size=256");
  assert.deepEqual(flags.execArgv.slice(1), ["--cpu-prof", "--cpu-prof-dir", "C:/tmp"]);
});

test("TIGHT 档是 soak 通过后的下一步（192）", () => {
  assert.equal(TIGHT_HOST_HEAP.maxOldSpaceSizeMb, 192);
  const flags = resolveHostHeapFlags({
    env: { PIFORGE_HOST_HEAP: `semi=${TIGHT_HOST_HEAP.maxSemiSpaceSizeMb},old=${TIGHT_HOST_HEAP.maxOldSpaceSizeMb}` },
  });
  assert.deepEqual(flags.execArgv, ["--js-flags=--max-old-space-size=192"]);
});

test("isHeapExhaustion 认得 V8 OOM 的两种表现，不把普通崩溃误判为 OOM", () => {
  assert.equal(isHeapExhaustion({ message: "JavaScript heap out of memory" }), true);
  assert.equal(isHeapExhaustion({ message: "FATAL ERROR: Reached heap limit Allocation failed" }), true);
  assert.equal(isHeapExhaustion({ exitCode: 134 }), true);
  assert.equal(isHeapExhaustion({ signal: "SIGABRT" }), true);
  assert.equal(isHeapExhaustion({ message: "connect ENOENT \\\\.\\pipe\\x" }), false);
  assert.equal(isHeapExhaustion({ exitCode: 1 }), false);
  assert.equal(isHeapExhaustion({}), false);
});
