#!/usr/bin/env node
/**
 * 护栏：`npm run dev:electron` 前确认 `out/` 不比源码旧。
 *
 *   node scripts/check-dev-static-freshness.mjs          # 旧了就退出 1
 *   node scripts/check-dev-static-freshness.mjs --warn   # 旧了只警告
 *
 * 修复：npm run build:static
 */
import process from "node:process";
import { checkDevStaticFreshness } from "./lib/dev-static-freshness.mjs";

const warnOnly = process.argv.includes("--warn") || process.env.PIFORGE_SKIP_STATIC_FRESHNESS === "1";
const result = checkDevStaticFreshness({ repoRoot: process.cwd() });

if (result.ok) {
  console.log(`check-dev-static-freshness: PASS（out/ ${result.details.ageSeconds}s 前导出，没有更新的源码）`);
  process.exit(0);
}

const lines = [
  "check-dev-static-freshness: FAIL",
  ...result.problems.map((problem) => `  - ${problem}`),
  "  渲染进程加载的是 out/ 里的静态导出；不重建就会跑旧 UI。",
  "  修复：npm run build:static",
];
if (warnOnly) {
  console.warn(lines.join("\n"));
  process.exit(0);
}
console.error(lines.join("\n"));
process.exit(1);
