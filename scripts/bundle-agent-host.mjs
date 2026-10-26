#!/usr/bin/env node
/**
 * 把 Agent Host + Pi SDK 打成**单文件 ESM**（冷启动优化，阶段表见 bench/startup_stats.py）。
 *
 * 为什么需要：`agent-host/dist` 是 tsc 逐文件产物，直接跑要过 Pi SDK 的整张 ESM 模块图
 * （打包版实测 5,917 个 .js，node_modules 共 20,239 个文件）。实测同一台机器上：
 *
 *   未打包入口 import  3,144 / 3,346 / 3,464 ms      ← 90% 的冷启动时间在这里
 *   单文件 bundle      697 / 720 / 740 ms            ← 只剩"读一个 15 MB 文件 + 编译"
 *
 * 所以 32 s 里绝大部分不是扩展发现 / toolchain 扫描 / MCP（这些实测都 < 100 ms），
 * 而是**按文件解析 ESM 图的固定开销**（每文件一次 stat/read/resolve）。
 *
 * 两个必须同步处理的 SDK 运行时耦合：
 *   1. `dist/utils/image-resize.js` 用 `new URL("./image-resize-worker.js", import.meta.url)`
 *      定位 Worker —— 打包后 import.meta.url 变成 bundle 自己，所以要把该文件复制到 bundle 旁边；
 *   2. `getPackageDir()` 从 `import.meta.url` 往上找 `package.json` —— 打包后找不到，
 *      由 `ensure-standalone-agent-host.mjs` 生成的入口 wrapper 先设 `PI_PACKAGE_DIR`。
 */
import { build } from "esbuild";
import { builtinModules } from "node:module";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const projectRoot = process.cwd();
const entry = path.join(projectRoot, "agent-host", "dist", "agent-host", "index.js");
const outDir = path.join(projectRoot, "agent-host", "bundle");
const outfile = path.join(outDir, "host.mjs");

/** SDK 里通过 `new URL(..., import.meta.url)` 定位的资源文件（打包后必须并排放）。 */
const runtimeAssets = [
  ["node_modules/@earendil-works/pi-coding-agent/dist/utils/image-resize-worker.js", "image-resize-worker.js"],
  /**
   * Photon（图片缩小/重编码）的 wasm。SDK 的 photon.js 内联进 bundle 后会用
   * `join(__dirname, "photon_rs_bg.wasm")` 去读它；bundle 是 ESM，原生没有
   * __dirname（见下方 banner）。缺任何一个 → loadPhoton() 返回 null →
   * 所有超限图片被 "[Image omitted: could not be resized…]" 吃掉。
   */
  ["node_modules/@earendil-works/pi-coding-agent/node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm", "photon_rs_bg.wasm"],
  /**
   * codemode 的 QuickJS worker 入口。SDK 在 `PI_BUNDLED_NODE` 为真时走
   * `resolveCodemodeWorkerSpecifier` 的 bundled-node 分支：
   * `new URL("./codemode-worker.js", import.meta.url)`（见 pi-coding-agent/dist/config.js）。
   * bundle 之后 import.meta.url 就是 host.mjs，所以必须把这个 chunk 复制到 bundle 旁边，
   * 否则 codemode 工具整体不可用（报 ENOENT .../agent-host/codemode-worker.js，
   * 打包版 0.11.x 中招，2026-10-26 修）。
   */
  ["node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks/codemode-worker.js", "codemode-worker.js"],
];

if (!existsSync(entry)) {
  console.error(`bundle-agent-host: missing ${entry} (run npm run build:agent-host)`);
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const result = await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  // Electron 43 内置 Node 24；本地 `npm run dev` 用 Node 24，两边都吃得下 node20 语法。
  target: "node20",
  absWorkingDir: projectRoot,
  logLevel: "warning",
  metafile: true,
  legalComments: "none",
  // 依赖一律打进单文件：留下任何 bare import 都会把 ESM 图重新引回来。
  packages: "bundle",
  /**
   * Pi SDK 用它判断「当前是不是打包过的 Node 发行版」（`config.ts` 的
   * `isBundledNode = typeof PI_BUNDLED_NODE !== "undefined" && PI_BUNDLED_NODE`）。
   * 不 define 的话它当自己是未打包的 dist 树，按 `import.meta.url`（= bundle 自己）
   * 算 alias 去加载**扩展**，加载失败被吞成一句 session 级报错
   * —— 表现就是「Host 起来了、RPC 全通，但用户扩展一条都不生效」
   * （v0.9.2 打 bundle 起就有，2026-10-25 由 macOS 打包冒烟的
   * extension_ui_request 超时抓出来；Windows/Linux 的 dist 没跑这条冒烟所以一直绿）。
   * 定义了之后走 SDK 预设的 embedded 路径：jiti/static + virtualModules。
   */
  define: { PI_BUNDLED_NODE: "true" },
  /**
   * ESM 输出里 esbuild 的 `__require` 需要外层有 `require` 才能工作，
   * 否则 CJS 依赖（cross-spawn → require("child_process")）会直接抛
   * "Dynamic require of \"child_process\" is not supported"。esbuild 生成的
   * `__require` 一旦看到作用域里有 `require` 就用它，所以 banner 里补一个。
   */
  banner: {
    js: [
      'import { createRequire as __piforgeCreateRequire } from "node:module"; const require = __piforgeCreateRequire(import.meta.url);',
      /**
       * ESM 没有 __dirname，而内联的 CJS 依赖（photon_rs.js 读 wasm）直接用她。
       * 指向 bundle 自身目录：复制到 resources/standalone/agent-host/ 依然能找到
       * 并排的 photon_rs_bg.wasm。
       */
      'import { fileURLToPath as __piforgeFileURLToPath } from "node:url"; const __dirname = __piforgeFileURLToPath(new URL(".", import.meta.url));',
    ].join("\n"),
  },
});

const source = readFileSync(outfile, "utf8");
// 只关心"真的会去磁盘找文件"的 bare specifier：node 内建模块（带不带 node: 前缀）不算。
const builtins = new Set(builtinModules);
const leftover = [...source.matchAll(/^\s*(?:import|export)\s[^;]*?from\s*"([^"]+)"/gmu)]
  .map((match) => match[1])
  .filter((specifier) => !specifier.startsWith(".") && !specifier.startsWith("file:"))
  .filter((specifier) => !specifier.startsWith("node:"))
  .filter((specifier) => !builtins.has(specifier))
  .filter((specifier) => !specifier.startsWith("data:") && !specifier.startsWith("bun:"));
if (leftover.length > 0) {
  console.error(
    `bundle-agent-host: 仍有未内联的依赖 import（会把 ESM 图拉回来）：${[...new Set(leftover)].slice(0, 5).join(", ")}`,
  );
  process.exit(1);
}

const copied = [];
for (const [from, to] of runtimeAssets) {
  const sourcePath = path.join(projectRoot, from);
  if (!existsSync(sourcePath)) continue;
  copyFileSync(sourcePath, path.join(outDir, to));
  copied.push(to);
}

const inputs = Object.keys(result.metafile.outputs[path.relative(projectRoot, outfile).split(path.sep).join("/")]?.inputs ?? result.metafile.inputs);
const sizeMb = (statSync(outfile).size / 1048576).toFixed(1);
console.log(
  `bundle-agent-host: ${inputs.length} modules → agent-host/bundle/host.mjs (${sizeMb} MB)` +
    (copied.length ? ` + assets: ${copied.join(", ")}` : ""),
);
