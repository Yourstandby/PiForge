import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSONL_WORKER_THRESHOLD_BYTES, parseJsonlFileInWorker } from "./jsonl-worker.ts";

function bigJsonlFile(dir: string, lineCount: number): string {
  const path = join(dir, "big.jsonl");
  const header = { type: "session", version: 1, id: "big", timestamp: new Date(0).toISOString(), cwd: "D:\\Proj" };
  const lines = [JSON.stringify(header)];
  // 每行 ~400 字节，3000 行 ≈ 1.2MB，确实超过 worker 阈值。
  for (let i = 0; i < lineCount; i++) {
    lines.push(JSON.stringify({ type: "message", id: `m${i}`, message: { role: "user", content: [{ type: "text", text: `payload ${i} `.repeat(30) }] } }));
  }
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
  return path;
}

test("large JSONL parses inside the worker thread and keeps every line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "piforge-jsonl-worker-"));
  try {
    const path = bigJsonlFile(dir, 3_000);
    const size = (await import("node:fs")).statSync(path).size;
    assert.ok(size > JSONL_WORKER_THRESHOLD_BYTES, "用例文件必须超过 worker 阈值");

    const result = await parseJsonlFileInWorker<{ type: string }>(path);
    assert.ok(result, "worker 必须返回结果（失败会回落内联路径）");
    assert.equal(result!.malformed, 0);
    assert.equal(result!.entries.length, 3_001);
    assert.equal(result!.entries[1]?.type, "message");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing file falls back instead of hanging", async () => {
  const result = await parseJsonlFileInWorker(join(tmpdir(), "piforge-does-not-exist.jsonl"));
  assert.equal(result, null);
});
