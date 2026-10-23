import type { NextConfig } from "next";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const projectRoot = dirname(fileURLToPath(import.meta.url));

const { version } = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as { version: string };
let piVersion = "unknown";
try {
  const piPkgPath = join(projectRoot, "node_modules/@earendil-works/pi-coding-agent/package.json");
  piVersion = (JSON.parse(readFileSync(piPkgPath, "utf8")) as { version: string }).version;
} catch { /* package not found, use default */ }

/**
 * P1-4：默认构建「静态导出」（`out/`，由 Electron `piforge://` 协议直出，无 HTTP 监听）；
 * `PIFORGE_NEXT_STANDALONE=1` 构建旧路径（`PIFORGE_USE_NEXT=1` 回退 + 打包取 node_modules 用）。
 */
const WANTS_STATIC_EXPORT = process.env.PIFORGE_NEXT_STANDALONE !== "1";

/**
 * 生产构建才切换 `output` / `distDir` / `pageExtensions`。
 *
 * 开发服务器（`next dev`）必须保留默认 `pageExtensions`：否则 `app/api/**\/route.ts`
 * 不被当成路由文件，`npm run dev` 的 `/api/*` 全部 404（P1-4 落地时踩到的坑，
 * 已在 `next.config.test` 之外的 dev 冒烟里复核）。
 *
 * 静态导出时去掉 `ts`：`app/api/**\/route.ts` 由 Agent Host 的
 * `agent-host/api-router.ts` 分派，Next 不该再把它当 route handler 编译 ——
 * 否则 `export const dynamic = "force-dynamic"` 会让静态导出直接报错。
 */
export default function config(phase: string): NextConfig {
  const isDevServer = phase === "phase-development-server";
  const staticExport = !isDevServer && WANTS_STATIC_EXPORT;

  return {
    output: staticExport ? "export" : "standalone",
    // 两套构建产物互不覆盖：静态导出用 `.next-static`（产物在 `out/`），
    // 回退用的 standalone 留在 `.next`（`npm run dev` 也用它）。
    distDir: staticExport ? ".next-static" : ".next",
    ...(staticExport ? { pageExtensions: ["tsx"] } : {}),
    // The dev-only floating "N" ball never ships in a build; hide it in dev too.
    devIndicators: false,
    turbopack: {},
    serverExternalPackages: ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-mcp"],
    allowedDevOrigins: ["127.0.0.1", "localhost", "192.168.*.*"],
    outputFileTracingIncludes: {
      "/*": ["./node_modules/@earendil-works/pi-ai/**/*"],
    },
    outputFileTracingExcludes: {
      '*': [
        'release/**/*',
        '.git/**/*',
        'dist/**/*',
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/*.test.mjs',
        '**/*.test.js',
        'middleware.test.ts',
        'package.test.ts',
      ],
    },
    env: {
      NEXT_PUBLIC_APP_VERSION: version,
      NEXT_PUBLIC_PI_VERSION: piVersion,
    },
  };
}
