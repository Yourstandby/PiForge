#!/usr/bin/env node
/**
 * 生成 Agent Host 侧的 API 路由表（`agent-host/api-routes.generated.ts`）。
 *
 * 背景：0.9.x 的 P1-4 把 70 条 `app/api/**\/route.ts` 从 Next 运行时搬进 Agent
 * Host（见 docs/optimizations/v0.9.x-performance-plan.md）。路由文件本身一行不改
 * ——它们已经是 Web 标准的 `(Request) => Response`，只依赖 `lib/next-server-shim.ts`。
 * 这里负责把「文件系统里的文件布局」编译成「路径模式 → 懒加载模块」的表。
 *
 * 为什么用懒加载 `import()`：Host 冷启动只付出一次模块解析的钱，
 * 只有真被请求到的路由才会被加载（本地实测 host_ready 3.1s，其中 2.0s 是 Pi SDK）。
 *
 * 约定：
 *   - `app/api/x/y/route.ts`      → `/api/x/y`
 *   - `app/api/x/[id]/route.ts`   → `/api/x/:id`
 *   - `app/api/x/[...rest]/route` → `/api/x/*rest`
 *   - 静态段优先于动态段（同层级先比段数，再比动态段数量）
 *
 * 生成物必须提交进仓库：tsc 需要它在 `include` 里，CI 也先跑本脚本。
 */
import { readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import process from "node:process";

const projectRoot = process.cwd();
const apiRoot = join(projectRoot, "app", "api");
const outFile = join(projectRoot, "agent-host", "api-routes.generated.ts");

if (!existsSync(apiRoot)) {
  console.error(`generate-api-routes: missing ${apiRoot}`);
  process.exit(1);
}

/** @returns {string[]} route.ts 的目录相对路径（已排序，保证生成物稳定） */
function findRouteFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      findRouteFiles(full, acc);
    } else if (entry.name === "route.ts") {
      acc.push(full);
    }
  }
  return acc;
}

const files = findRouteFiles(apiRoot).sort();

const routes = files.map((file) => {
  const rel = relative(apiRoot, file).replace(/\\/g, "/");
  const segments = rel.replace(/\/?route\.ts$/, "").split("/").filter(Boolean);
  const pattern = `/api${segments.length > 0 ? `/${segments.join("/")}` : ""}`;
  const dynamicCount = segments.filter((segment) => segment.startsWith("[")).length;
  const importPath = relative(join(projectRoot, "agent-host"), file).replace(/\\/g, "/");
  return {
    pattern,
    segments,
    dynamicCount,
    importPath: importPath.startsWith(".") ? importPath : `./${importPath}`,
    source: relative(projectRoot, file).split(sep).join("/"),
  };
});

// 静态优先：段数多的先匹配（`/api/files/apply` 要赢过 `/api/files/[...path]`），
// 同段数时动态段少的先匹配。
routes.sort((a, b) => {
  if (a.segments.length !== b.segments.length) return b.segments.length - a.segments.length;
  if (a.dynamicCount !== b.dynamicCount) return a.dynamicCount - b.dynamicCount;
  return a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0;
});

const body = `/**
 * ⚠️ 自动生成，不要手改 —— 由 \`node scripts/generate-api-routes.mjs\` 产出。
 * 路由数量：${routes.length}
 */
export interface ApiRouteEntry {
  /** 归一化后的路径模式（\`:param\` / \`*rest\`）。 */
  pattern: string;
  /** 静态段优先的排序权重（生成时已排好序，这里保留给调试用）。 */
  segments: string[];
  /** 懒加载器：只有被请求到时才解析模块。 */
  load: () => Promise<Record<string, unknown>>;
}

export const API_ROUTES: ApiRouteEntry[] = [
${routes
  .map(
    (route) => `  {
    pattern: ${JSON.stringify(route.pattern)},
    segments: ${JSON.stringify(route.segments)},
    load: () => import(${JSON.stringify(route.importPath)}),
  },`,
  )
  .join("\n")}
];
`;

writeFileSync(outFile, body, "utf8");
console.log(`generate-api-routes: ${routes.length} routes → ${relative(projectRoot, outFile)}`);
