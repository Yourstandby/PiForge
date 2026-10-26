#!/usr/bin/env node
/**
 * 跑 `scripts/smoke-image-worker.cjs`：先把生产用的 worker 源码写出来，
 * 再用本地 Electron 二进制（绕开 `node_modules/electron` 的 path.txt 问题，
 * 同 scripts/run-electron.mjs）启动真机冒烟。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { buildWorkerSource } from "../lib/image-worker.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(repoRoot, "node_modules", "electron", "dist");
const binaryByPlatform = {
  win32: "electron.exe",
  darwin: "Electron.app/Contents/MacOS/Electron",
  linux: "electron",
};
const binary = path.join(distDir, binaryByPlatform[process.platform] ?? "electron");
if (!existsSync(binary)) {
  console.error(`Electron 二进制不存在：${binary}`);
  process.exit(1);
}

const workDir = mkdtempSync(path.join(tmpdir(), "piforge-image-worker-"));
const sourceFile = path.join(workDir, "worker-source.js");
writeFileSync(
  sourceFile,
  buildWorkerSource({
    maxEdge: 1568,
    maxPixels: 1_150_000,
    passthroughBytes: 6 * 1024 * 1024,
    thumbEdge: 160,
    thumbQuality: 0.75,
    jpegQuality: 0.92,
  }),
);

const env = { ...process.env, IMAGE_WORKER_SOURCE_FILE: sourceFile };
// 必须**真删除**：Windows 上传空字符串仍然算「已设置」，Electron 会当成
// ELECTRON_RUN_AS_NODE 模式跑，`require("electron")` 就只剩 npm 包而没有 app API。
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(binary, [path.join(repoRoot, "scripts", "smoke-image-worker.mjs")], {
  cwd: repoRoot,
  stdio: "inherit",
  env,
});

const cleanup = () => rmSync(workDir, { recursive: true, force: true });
child.on("error", (error) => {
  cleanup();
  console.error(`无法启动 Electron: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code) => {
  cleanup();
  process.exit(code ?? 0);
});
