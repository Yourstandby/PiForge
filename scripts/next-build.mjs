#!/usr/bin/env node
/**
 * `next build` 的两套模式（P1-4）。
 *
 *   node scripts/next-build.mjs               # 默认：静态导出 → `out/`（Electron piforge:// 直出）
 *   node scripts/next-build.mjs --standalone  # 回退：Next standalone → `.next/standalone`
 *
 * ⚠️ **顺序约束：静态导出必须在 standalone 之前跑**。Next 的 export 构建会清理
 * `.next/`，实测会把 `.next/standalone`（裁剪后的 node_modules + agent-host 入口）
 * 整棵树删掉。所以 `pack` / `dist` 是 `build:static && build:standalone`；
 * 反过来会得到"壳能开、引擎起不来"的安装包。打包冒烟
 * （`smoke-packaged-static.mjs`）会断言 `resources/standalone/agent-host/index.js`
 * 存在，顺序写错时立刻失败（本轮就是这么发现的）。
 *
 * 为什么要有 wrapper：`PIFORGE_NEXT_STANDALONE=1 next build` 在 Windows 的
 * cmd/PowerShell 下写法不一致（项目不引入 cross-env），用一个小的 node wrapper
 * 就能两端一致，也避免把环境变量写进 package.json 的一长串命令里。
 *
 * 两套产物目录互不覆盖：静态导出用 `.next-static`，standalone 用 `.next`
 * （见 next.config.ts 的 distDir）。
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const standalone = process.argv.includes("--standalone");
const repoRoot = process.cwd();

const nextBin = path.join(repoRoot, "node_modules", "next", "dist", "bin", "next");
if (!existsSync(nextBin)) {
  console.error("next-build: next is not installed (npm install)");
  process.exit(1);
}

const env = { ...process.env };
if (standalone) {
  env.PIFORGE_NEXT_STANDALONE = "1";
} else {
  delete env.PIFORGE_NEXT_STANDALONE;
}

const result = spawnSync(process.execPath, [nextBin, "build"], {
  cwd: repoRoot,
  env,
  stdio: "inherit",
});
if (result.status !== 0) process.exit(result.status ?? 1);

if (!standalone) {
  /**
   * `output: "export"` 的产物目录跟 `distDir` 走：设了 `.next-static` 之后，
   * Next 16 会把 HTML/`_next` 直接写进 `.next-static/`，**不再**写 `out/`。
   *
   * 这个坑踩过一次：`out/` 停留在旧构建上，打包出来跑的是几小时前的 UI
   * （改了的轮询/动画全都没生效，但宿主侧是新代码，指标看起来"部分改善"）。
   * 所以这里显式同步，并在同步后**校验** chunk 文件名与导出目录一致。
   */
  const distDir = path.join(repoRoot, ".next-static");
  const outDir = path.join(repoRoot, "out");
  const exportDir = existsSync(path.join(distDir, "index.html")) ? distDir : outDir;
  if (!existsSync(path.join(exportDir, "index.html"))) {
    console.error("next-build: static export produced no index.html (checked .next-static/ and out/)");
    process.exit(1);
  }
  if (exportDir !== outDir) {
    rmSync(outDir, { recursive: true, force: true });
    cpSync(exportDir, outDir, { recursive: true, force: true });
  }
  const files = readdirSync(outDir).length;
  const chunks = path.join(outDir, "_next", "static", "chunks");
  const sourceChunks = path.join(exportDir, "_next", "static", "chunks");
  if (existsSync(sourceChunks)) {
    const expected = readdirSync(sourceChunks).sort().join(",");
    const actual = existsSync(chunks) ? readdirSync(chunks).sort().join(",") : "";
    if (expected !== actual) {
      console.error("next-build: out/_next/static/chunks does not match the fresh export");
      process.exit(1);
    }
  }
  const ageSeconds = (Date.now() - statSync(path.join(outDir, "index.html")).mtimeMs) / 1000;
  if (ageSeconds > 300) {
    console.error(`next-build: out/index.html is stale (${Math.round(ageSeconds)}s old)`);
    process.exit(1);
  }
  console.log(`next-build: static export ready → out/ (${files} entries, chunks verified)`);
} else {
  if (!existsSync(path.join(repoRoot, ".next", "standalone", "server.js"))) {
    console.error("next-build: standalone build missing .next/standalone/server.js");
    process.exit(1);
  }
  console.log("next-build: standalone build ready → .next/standalone");
}
