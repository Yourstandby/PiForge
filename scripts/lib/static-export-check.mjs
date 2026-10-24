/**
 * 静态导出产物自检（`out/` 新鲜度 + chunk 名单一致）。
 *
 * 为什么单独抽出来：本轮踩过一个坑 —— `next.config.ts` 把静态导出的 `distDir`
 * 换成 `.next-static` 之后，Next 把 HTML/`_next` 写进了 `.next-static/`，
 * **`out/` 停留在旧构建**，于是打包出来跑的是几小时前的 UI（改了的定时器/动画
 * 全没生效，但宿主是新代码，指标"看起来部分改善"）。
 *
 * 这里把判定抽成纯函数，两处复用：
 *   1. `scripts/next-build.mjs`（构建结束时自检，失败即中断）；
 *   2. `scripts/smoke-static-freshness.mjs`（CI 独立护栏，可在打包前单独跑）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * 新鲜度阈值：只在**显式要求**时检查（`maxAgeMs` 为 null 时跳过）。
 *
 * 原因：chunk 名单一致已经能证明"out/ 就是本次构建产物"；而时间窗口取决于
 * 调用点（`next-build` 刚构建完是 10 分钟，`pack` 链里要等 standalone + builder
 * 跑完，可能更久）。写死会让 CI 假红。
 */
const DEFAULT_MAX_AGE_MS = null;

/**
 * @returns {{ ok: boolean, problems: string[], details: Record<string, unknown> }}
 */
export function checkStaticExport({ repoRoot, maxAgeMs = DEFAULT_MAX_AGE_MS, now = Date.now() }) {
  const outDir = path.join(repoRoot, "out");
  const distDir = path.join(repoRoot, ".next-static");
  const problems = [];
  const details = { outDir, exportDir: distDir, ageSeconds: null, chunkCount: null };

  const outIndex = path.join(outDir, "index.html");
  if (!existsSync(outIndex)) {
    problems.push("out/index.html 不存在（还没跑 npm run build:static？）");
    return { ok: false, problems, details };
  }

  const ageMs = now - statSync(outIndex).mtimeMs;
  details.ageSeconds = Math.round(ageMs / 1000);
  details.maxAgeSeconds = maxAgeMs === null ? null : Math.round(maxAgeMs / 1000);
  if (maxAgeMs !== null && ageMs > maxAgeMs) {
    problems.push(`out/index.html 太旧（${Math.round(ageMs / 1000)}s > ${Math.round(maxAgeMs / 1000)}s），可能没重新导出`);
  }

  // 导出目录（Next 16 会写到 distDir 里）与 out/ 的 chunk 名单必须完全一致：
  // 这是"out/ 是本次构建产物"最直接的证据。
  const sourceChunks = path.join(distDir, "_next", "static", "chunks");
  const outChunks = path.join(outDir, "_next", "static", "chunks");
  if (existsSync(sourceChunks)) {
    if (!existsSync(outChunks)) {
      problems.push("out/_next/static/chunks 不存在（导出产物没同步到 out/）");
    } else {
      const expected = readdirSync(sourceChunks).sort();
      const actual = readdirSync(outChunks).sort();
      details.chunkCount = actual.length;
      const missing = expected.filter((name) => !actual.includes(name));
      const extra = actual.filter((name) => !expected.includes(name));
      if (missing.length > 0) problems.push(`out/ 缺少 ${missing.length} 个新 chunk（例如 ${missing[0]}）`);
      if (extra.length > 0) problems.push(`out/ 残留 ${extra.length} 个旧 chunk（例如 ${extra[0]}）`);
    }
  }

  // index.html 引用到的入口脚本必须真实存在（漏拷会在运行期白屏）。
  const html = existsSync(outIndex) ? readFileSafe(outIndex) : "";
  for (const match of html.matchAll(/src="(\/_next\/static\/[^"]+\.js)"/g)) {
    const asset = path.join(outDir, match[1].replace(/^\//, ""));
    if (!existsSync(asset)) problems.push(`index.html 引用的脚本缺失：${match[1]}`);
  }

  return { ok: problems.length === 0, problems, details };
}

function readFileSafe(file) {
  try {
    // 同步读：调用点都是构建/CI 脚本，不需要异步复杂度。
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
