import test from "node:test";
import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "os";
import { join } from "path";
import { Worker } from "node:worker_threads";
import { writeFileAtomic } from "./atomic-write.ts";

test("writeFileAtomic writes complete content and replaces old content", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-atomic-write-"));
  try {
    const target = join(dir, "settings.json");
    writeFileSync(target, "x".repeat(4096));
    writeFileAtomic(target, '{"n": 1}');
    assert.equal(readFileSync(target, "utf-8"), '{"n": 1}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A reader handle open on the target makes renameSync fail with EPERM on
// Windows. The writer's retry loop blocks its own event loop, so only another
// thread can release the conflict mid-call — hence the worker thread.
test("writeFileAtomic retries rename while a reader holds the target open", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-atomic-write-"));
  const worker = new Worker(
    `const { openSync, closeSync } = require("node:fs");
     const { parentPort, workerData } = require("node:worker_threads");
     const fd = openSync(workerData.target, "r");
     parentPort.postMessage("armed");
     setTimeout(() => {
       closeSync(fd);
       parentPort.postMessage("released");
     }, workerData.holdMs);`,
    { eval: true, workerData: { target: join(dir, "settings.json"), holdMs: 60 } },
  );
  try {
    const target = join(dir, "settings.json");
    writeFileSync(target, "old");
    await new Promise<void>((resolve) =>
      worker.once("message", (m: string) => m === "armed" && resolve()),
    );

    // Retry budget (200 x 5ms = 1s) comfortably covers the 60ms hold, so the
    // rename must succeed via the retry path, not the direct-write fallback.
    writeFileAtomic(target, '{"n": 2}', { retryIntervalMs: 5, maxRenameAttempts: 200 });
    assert.equal(readFileSync(target, "utf-8"), '{"n": 2}');

    await new Promise<void>((resolve) =>
      worker.once("message", (m: string) => m === "released" && resolve()),
    );
  } finally {
    await worker.terminate();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeFileAtomic falls back to a direct write when rename stays blocked", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-atomic-write-"));
  try {
    const target = join(dir, "settings.json");
    writeFileSync(target, "old");
    const fd = openSync(target, "r");
    try {
      // Deliberately tiny budget: the handle stays open for the whole call,
      // so the write must degrade to the direct path instead of throwing.
      writeFileAtomic(target, '{"n": 3}', {
        retryIntervalMs: 1,
        maxRenameAttempts: 2,
        sleepSync: () => {},
      });
      assert.equal(readFileSync(target, "utf-8"), '{"n": 3}');
    } finally {
      closeSync(fd);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 技能目录里装进来的 SKILL.md 常带 +H；Windows 用 "w"（写 + 截断）打开这种文件
// 会被内核拒成 EPERM，而 rename 覆盖同一个文件是允许的 —— 这正是「技能开关点了
// 报 EPERM」的根因，所以这两条是回归测试。
const hiddenFileTest = process.platform === "win32" ? test : test.skip;

hiddenFileTest("writeFileAtomic 能写带隐藏属性的文件（writeFileSync 会 EPERM）", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-atomic-write-hidden-"));
  try {
    const target = join(dir, "SKILL.md");
    writeFileSync(target, "old");
    execFileSync("attrib", ["+h", target]);
    assert.throws(() => writeFileSync(target, "new"), /EPERM/);

    writeFileAtomic(target, "new");
    assert.equal(readFileSync(target, "utf-8"), "new");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

hiddenFileTest("rename 被占用且「w」被拒时退化为句柄内重写", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-atomic-write-hidden-"));
  try {
    const target = join(dir, "SKILL.md");
    writeFileSync(target, "old");
    execFileSync("attrib", ["+h", target]);
    // 读者持有句柄 → rename 必然失败；直接写又撞 EPERM，只能走 writeInPlace。
    const fd = openSync(target, "r");
    try {
      writeFileAtomic(target, "short", {
        retryIntervalMs: 1,
        maxRenameAttempts: 2,
        sleepSync: () => {},
      });
      assert.equal(readFileSync(target, "utf-8"), "short");
    } finally {
      closeSync(fd);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
