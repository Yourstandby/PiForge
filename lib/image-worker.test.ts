/**
 * worker 源码是字符串，最容易出的错是「拼接时少个引号 / 常量没注进去」，
 * 而这类错误只有用户真的贴图才会暴露。这里在单测里编译一遍，把问题挡在 CI。
 */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildWorkerSource } from "./image-worker.ts";
import type { ImageWorkerOptions } from "./image-worker.ts";

const OPTIONS: ImageWorkerOptions = {
  maxEdge: 1568,
  maxPixels: 1_150_000,
  passthroughBytes: 6 * 1024 * 1024,
  thumbEdge: 160,
  thumbQuality: 0.75,
  jpegQuality: 0.92,
};

test("worker source compiles as a classic script", () => {
  const source = buildWorkerSource(OPTIONS);
  // 编译而不执行：顶层只有定义与 self.onmessage 赋值，执行需要 worker 全局。
  assert.ok(new vm.Script(source, { filename: "image-worker.js" }));
});

test("worker source carries the same budget as the main thread", () => {
  const source = buildWorkerSource(OPTIONS);
  const injected = source.match(/^const OPTS = (\{.*\});$/m);
  assert.ok(injected, "OPTS line missing");
  assert.deepEqual(JSON.parse(injected[1]), OPTIONS);
});
