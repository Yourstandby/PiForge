/**
 * 打包产物静态资源完整性（不需要 GUI，不需要 Electron）。
 *
 * 为什么要有：`resources/static/index.html` 里的每个 `/_next/static/...` 都必须
 * 真的躺在 `resources/static/` 下。少了任何一个 chunk，Chromium 会正常渲染 SSR
 * 出来的空壳（innerText 约 160 字）但**永远不会 hydrate** —— 表现就是"后端 API
 * 正常、页面白屏/正文过短"。这种缺口 `smoke-packaged-layout` 只查 chunks 目录
 * 存在与否是看不出来的，GUI 冒烟又要等 18 分钟才红，所以在这里提前钉死。
 *
 * 复用点：`scripts/smoke-packaged-layout.mjs`（打包后立即跑，秒级）。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** 只关心根绝对路径（`piforge://app/` 下它们映射到 resources/static）。 */
function rootAbsoluteAssets(html) {
  const found = new Set();
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const url = match[1];
    if (!url.startsWith("/")) continue;
    // 去掉 query/hash：`/favicon.ico?favicon.x.ico` 实际文件是 `/favicon.ico`。
    const bare = url.split("?")[0].split("#")[0];
    found.add(bare);
  }
  return [...found].sort();
}

/**
 * @returns {{ ok: boolean, problems: string[], details: Record<string, unknown> }}
 */
export function checkPackagedStaticAssets(resourcesDir) {
  const staticDir = path.join(resourcesDir, "static");
  const indexPath = path.join(staticDir, "index.html");
  const problems = [];
  const details = { staticDir, indexHtml: false, referenced: 0, missing: [], checked: [] };

  if (!existsSync(indexPath)) {
    problems.push(`缺少静态直出 index.html：${indexPath}`);
    return { ok: false, problems, details };
  }
  details.indexHtml = true;

  const assets = rootAbsoluteAssets(readFileSync(indexPath, "utf8"));
  details.referenced = assets.length;
  details.checked = assets;

  for (const asset of assets) {
    // 只校验我们自己的构建产物与本地静态文件；外部协议/绝对 URL 已在上面过滤。
    const file = path.join(staticDir, asset.replace(/^\/+/, ""));
    if (!existsSync(file)) details.missing.push(asset);
  }

  if (details.missing.length > 0) {
    problems.push(
      `resources/static 缺少 ${details.missing.length} 个 index.html 引用的资源（例如 ${details.missing[0]}）` +
        "：渲染进程会白屏、正文停在 SSR 空壳",
    );
  }

  return { ok: problems.length === 0, problems, details };
}
