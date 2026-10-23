#!/usr/bin/env node
/**
 * 路由依赖审计：每条 `/api/**` 路由会拉进哪些模块、占多少字节、常驻后谁来背。
 *
 *   node scripts/audit-route-deps.mjs               # 人类可读
 *   node scripts/audit-route-deps.mjs --json        # 机读
 *   node scripts/audit-route-deps.mjs --top 15      # 只显示最重的 N 条
 *
 * 为什么要这个：P1-4 之后 Host 同时承担 Pi SDK + 外壳 API 层，
 * "哪条路由把哪个重模块变成常驻"必须可审计，否则 host 内存/CPU 只能靠猜。
 *
 * 做法：从编译产物（agent-host/dist/app/api/**\/route.js）出发，按 `from "…"` /
 * `import("…")` 走**静态**依赖图（动态 import 会被标记为 lazy，不计入首屏常驻），
 * 把仓库内模块与 node_modules 包分开统计。
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const topIndex = args.indexOf("--top");
const top = topIndex === -1 ? null : Number(args[topIndex + 1]);

const repoRoot = process.cwd();
const distRoot = path.join(repoRoot, "agent-host", "dist");
const apiRoot = path.join(distRoot, "app", "api");

const IMPORT_RE = /(?:from\s+"([^"]+)"|import\(\s*"([^"]+)"\s*\))/g;

function readImports(file) {
  if (!existsSync(file)) return [];
  const source = readFileSync(file, "utf8");
  const found = [];
  for (const match of source.matchAll(IMPORT_RE)) {
    const spec = match[1] ?? match[2];
    if (!spec || !(spec.startsWith(".") || spec.startsWith("/") || !spec.startsWith("node:"))) continue;
    found.push({ spec, dynamic: match[1] === undefined });
  }
  return found;
}

/** 相对 specifier → dist 里的绝对路径（tcs 已经写成 `.js`）。 */
function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, `${base}.js`, path.join(base, "index.js")];
  for (const candidate of candidates) {
    if (candidate.endsWith(".js") && existsSync(candidate)) return candidate;
  }
  return null;
}

function packageNameOf(spec) {
  if (spec.startsWith("@")) return spec.split("/").slice(0, 2).join("/");
  return spec.split("/")[0];
}

/** 从一条 route.js 出发，收集静态可达模块 + 懒加载模块 + 第三方包。 */
function walk(entry) {
  const eager = new Set();
  const lazy = new Set();
  const packages = new Set();
  const stack = [[entry, false]];
  while (stack.length > 0) {
    const [file, isLazy] = stack.pop();
    if (!file) continue;
    const bucket = isLazy ? lazy : eager;
    if (bucket.has(file) || eager.has(file)) continue;
    bucket.add(file);
    for (const { spec, dynamic } of readImports(file)) {
      if (spec.startsWith(".") || spec.startsWith("/")) {
        stack.push([resolveRelative(file, spec), isLazy || dynamic]);
        continue;
      }
      if (spec.startsWith("node:")) continue;
      packages.add(`${packageNameOf(spec)}${dynamic ? " (lazy)" : ""}`);
    }
  }
  return { eager, lazy, packages };
}

function filesUnder(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = readFileSystem(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === "route.js") out.push(full);
    }
  }
  return out.sort();
}

import { readdirSync } from "node:fs";
function readFileSystem(dir) {
  return readdirSync(dir, { withFileTypes: true });
}

const sizeOf = (file) => {
  try {
    return readFileSync(file).length;
  } catch {
    return 0;
  }
};

if (!existsSync(apiRoot)) {
  console.error("audit-route-deps: 缺少 agent-host/dist/app/api（先 npm run build:agent-host）");
  process.exit(1);
}

const packageOwners = new Map();
const rows = filesUnder(apiRoot).map((entry) => {
  const route = `/${path.relative(distRoot, entry).split(path.sep).join("/")}`.replace("/app/api", "/api").replace(/\/route\.js$/, "");
  const { eager, lazy, packages } = walk(entry);
  const eagerBytes = [...eager].reduce((sum, file) => sum + sizeOf(file), 0);
  const lazyBytes = [...lazy].reduce((sum, file) => sum + sizeOf(file), 0);
  for (const pkg of packages) {
    const list = packageOwners.get(pkg) ?? [];
    list.push(route);
    packageOwners.set(pkg, list);
  }
  return {
    route,
    eagerModules: eager.size,
    eagerKb: Number((eagerBytes / 1024).toFixed(1)),
    lazyModules: lazy.size,
    lazyKb: Number((lazyBytes / 1024).toFixed(1)),
    packages: [...packages].sort(),
  };
});

rows.sort((a, b) => b.eagerKb - a.eagerKb);
const shared = [...packageOwners.entries()]
  .map(([pkg, routes]) => ({ pkg, routes: [...new Set(routes)] }))
  .sort((a, b) => b.routes.length - a.routes.length);

if (asJson) {
  console.log(JSON.stringify({ routes: rows, packages: shared }, null, 2));
  process.exit(0);
}

const shown = top ? rows.slice(0, top) : rows;
console.log(`路由依赖审计（静态可达，来自 ${path.relative(repoRoot, apiRoot)}）：${rows.length} 条路由\n`);
console.log("路由                                        常驻模块  常驻KB   懒加载  懒加载KB  第三方包");
for (const row of shown) {
  console.log(
    `${row.route.padEnd(42)} ${String(row.eagerModules).padStart(6)}  ${String(row.eagerKb).padStart(7)}  ${String(row.lazyModules).padStart(6)}  ${String(row.lazyKb).padStart(7)}  ${row.packages.join(",") || "-"}`,
  );
}
console.log("\n第三方包归属（拉进它的路由越多，越说明该包是被哪条路由常驻的）：");
for (const item of shared.slice(0, 20)) {
  console.log(`  ${item.pkg.padEnd(46)} ${item.routes.length} 条: ${item.routes.slice(0, 4).join(" ")}${item.routes.length > 4 ? " …" : ""}`);
}
