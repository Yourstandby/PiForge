/**
 * 开发版（`npm run dev:electron`）的前端产物新鲜度检查。
 *
 * 为什么需要：`dev:electron` 只重编 electron 主进程与 agent-host，
 * 渲染进程加载的 `piforge://app/` 来自 `out/`（静态导出）。源码改了但没重跑
 * `npm run build:static` 时，跑起来的是**旧 UI** —— 新加的功能看不见，
 * 看起来像"功能没做"。2026-11-04 侧栏项目重命名/移除就是这样被误判的。
 *
 * 和 `scripts/lib/static-export-check.mjs` 的分工：
 *   - 那边查"out/ 和 .next-static 是不是同一次构建"（结构一致，CI 用）；
 *   - 这边查"out/ 是不是比源码旧"（跨多次构建，开发时用）。
 * 两者互补：源码改了、两次产物都还是旧的，结构检查仍是 PASS。
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/** UI 源码根：任何一项改动都要求重新导出 out/。 */
const SOURCE_DIRS = ["app", "components", "lib", "hooks", "public"];
const SOURCE_FILES = ["next.config.ts", "tailwind.config.ts", "postcss.config.mjs"];
/** 不参与比较的目录：构建产物与依赖。 */
const SKIP_DIRS = new Set(["node_modules", ".next", ".next-static", "out", ".git", "release", "dist"]);
/** 不参与比较的扩展名：单测和文档改动不影响打包出来的 UI。 */
const SKIP_SUFFIXES = [".test.ts", ".test.tsx", ".test.mjs", ".test.js", ".md", ".map"];

/**
 * @returns {{ ok: boolean, problems: string[], details: {
 *   outIndex: string, ageSeconds: number | null, staleCount: number, staleFiles: string[],
 * } }}
 */
export function checkDevStaticFreshness({ repoRoot, toleranceMs = 5000 }) {
  const outIndex = path.join(repoRoot, "out", "index.html");
  const details = { outIndex, ageSeconds: null, staleCount: 0, staleFiles: [] };
  if (!existsSync(outIndex)) {
    return { ok: false, problems: ["out/index.html 不存在（从没跑过 npm run build:static）"], details };
  }
  const outMtime = statSync(outIndex).mtimeMs;
  const cutoff = outMtime + toleranceMs;

  const stale = [];
  for (const dir of SOURCE_DIRS) collect(path.join(repoRoot, dir), repoRoot, cutoff, stale);
  for (const file of SOURCE_FILES) {
    const fullPath = path.join(repoRoot, file);
    if (existsSync(fullPath) && statSync(fullPath).mtimeMs > cutoff) stale.push({ file, mtimeMs: statSync(fullPath).mtimeMs });
  }

  stale.sort((a, b) => b.mtimeMs - a.mtimeMs);
  details.staleCount = stale.length;
  details.staleFiles = stale.slice(0, 5).map((item) => item.file);
  details.ageSeconds = Math.max(0, Math.round((Date.now() - outMtime) / 1000));

  const problems = [];
  if (stale.length > 0) {
    problems.push(`有 ${stale.length} 个源码文件比 out/ 新（最近：${details.staleFiles.join("、")}）`);
  }
  return { ok: problems.length === 0, problems, details };
}

function collect(dir, repoRoot, cutoff, found) {
  if (!existsSync(dir)) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collect(fullPath, repoRoot, cutoff, found);
      continue;
    }
    if (!entry.isFile()) continue;
    if (SKIP_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue;
    let mtimeMs;
    try {
      mtimeMs = statSync(fullPath).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs > cutoff) found.push({ file: path.relative(repoRoot, fullPath).replaceAll("\\", "/"), mtimeMs });
  }
}
