#!/usr/bin/env node
/**
 * CI 护栏：静态导出产物 `out/` 必须是**本次构建**的（不是几小时前的）。
 *
 *   node scripts/smoke-static-freshness.mjs
 *   node scripts/smoke-static-freshness.mjs --max-age-minutes 2
 *
 * 失败情形（都会让 CI 红）：
 *   - out/index.html 不存在（没跑 build:static）；
 *   - 传了 `--max-age-minutes N` 且 index.html 比 N 分钟更旧（"这次没重新导出"）；
 *   - out/_next/static/chunks 与 .next-static 的 chunk 名单不一致（漏拷/残留旧文件）；
 *   - index.html 引用的入口脚本在 out/ 里不存在（运行期会白屏）。
 *
 * 背景：distDir 切到 `.next-static` 后，Next 曾把产物写在 `.next-static/` 而
 * `out/` 保持旧内容 —— 打包出来跑的是旧 UI。这个脚本是那次事故的护栏。
 */
import process from "node:process";
import { checkStaticExport } from "./lib/static-export-check.mjs";

const args = process.argv.slice(2);
const maxAgeIndex = args.indexOf("--max-age-minutes");
// 默认只校验"结构一致"（chunk 名单 + 入口脚本存在），时间窗口按需开启：
//   node scripts/smoke-static-freshness.mjs --max-age-minutes 10
const maxAgeMs =
  maxAgeIndex === -1 ? null : Math.max(1, Number(args[maxAgeIndex + 1])) * 60 * 1000;

const result = checkStaticExport({ repoRoot: process.cwd(), maxAgeMs });
if (result.ok) {
  console.log(
    `smoke-static-freshness: PASS（out/index.html ${result.details.ageSeconds}s、` +
      `${result.details.chunkCount ?? "?"} 个 chunk 与 .next-static 一致）`,
  );
  process.exit(0);
}
console.error("smoke-static-freshness: FAIL");
for (const problem of result.problems) console.error(`  - ${problem}`);
console.error(`  详情：${JSON.stringify(result.details)}`);
console.error("  修复：npm run build:static（会重新导出并把 .next-static 同步到 out/）");
process.exit(1);
