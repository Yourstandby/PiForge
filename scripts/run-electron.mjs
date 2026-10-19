#!/usr/bin/env node
/**
 * Launch the local Electron binary directly.
 *
 * `npx electron` resolves the executable through `node_modules/electron/index.js`,
 * which trusts `path.txt`. Some Windows endpoint-protection drivers transparently
 * encrypt that file (`%TSD-Header-###%`), so the CLI reads garbage, believes the
 * binary is missing and tries to re-download it — which fails behind a blocked
 * GitHub. Pointing at `node_modules/electron/dist` skips the whole resolution
 * path. It also keeps `dev:electron` working on macOS/Linux.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(repoRoot, "node_modules", "electron", "dist");

const BINARY_BY_PLATFORM = {
  win32: ["electron.exe"],
  darwin: ["Electron.app/Contents/MacOS/Electron"],
  linux: ["electron"],
};

function findBinary() {
  const candidates = BINARY_BY_PLATFORM[process.platform] ?? ["electron"];
  for (const relative of candidates) {
    const fullPath = path.join(distDir, relative);
    if (existsSync(fullPath)) return fullPath;
  }
  return null;
}

const binary = findBinary();
if (!binary) {
  console.error(
    [
      "Electron 二进制不存在：" + distDir,
      "",
      "重新下载（国内建议使用镜像）：",
      "  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js",
    ].join("\n"),
  );
  process.exit(1);
}

const child = spawn(binary, [repoRoot, ...process.argv.slice(2)], {
  cwd: repoRoot,
  stdio: "inherit",
  env: process.env,
});

child.on("error", (error) => {
  console.error(`无法启动 Electron: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
