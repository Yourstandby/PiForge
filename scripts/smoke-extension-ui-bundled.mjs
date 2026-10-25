#!/usr/bin/env node
/**
 * 单文件 Host bundle 的扩展加载护栏。
 *
 * 为什么要有：打包版 Host 优先跑 `agent-host/bundle/host.mjs`（冷启动 3.1s → 0.7s）。
 * 但 Pi SDK 靠 `PI_BUNDLED_NODE` 这个 define 判断「我是不是被打包过」：
 *
 *   isBundledNode = typeof PI_BUNDLED_NODE !== "undefined" && PI_BUNDLED_NODE
 *
 * 没定义时它以为自己在跑未打包的 dist 树，按 `import.meta.url`（打包后就是 bundle
 * 自己）算 alias 去 import 用户扩展，失败被吞成 session 级报错 —— Host 起来了、
 * RPC 全通、`agent.create` / `agent.subscribe` 都回包，但用户的扩展一条都不生效。
 * v0.9.2 打 bundle 起一直如此，2026-10-25 才被 macOS 打包冒烟的
 * `extension_ui_request` 超时抓出来（Windows/Linux 的 dist 那时不跑那条冒烟）。
 *
 * 做法：复刻打包布局（wrapper `index.js` → `./host.mjs`，旁边就是编译树），
 * 再把 `smoke-extension-ui-bridge.mjs` 指向这个入口跑一遍。编译树也在，所以
 * 回退路径同样经过同一目录（wrapper 里 `PI_PACKAGE_DIR` 与打包版一致）。
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptsDir, "..");

const distDir = path.join(projectRoot, "agent-host", "dist");
const bundleDir = path.join(projectRoot, "agent-host", "bundle");
if (!existsSync(path.join(distDir, "agent-host", "index.js"))) {
  console.error("smoke-extension-ui-bundled: missing agent-host/dist (run npm run build:agent-host)");
  process.exit(1);
}
if (!existsSync(path.join(bundleDir, "host.mjs"))) {
  console.error("smoke-extension-ui-bundled: missing agent-host/bundle/host.mjs (run npm run bundle:agent-host)");
  process.exit(1);
}

/** 打包版 wrapper 里的 sdkDir 是 `<Resources>/standalone/node_modules/...`，这里对应仓库的 node_modules。 */
const sdkDir = path.join(projectRoot, "node_modules", "@earendil-works", "pi-coding-agent");
if (!existsSync(path.join(sdkDir, "package.json"))) {
  console.error("smoke-extension-ui-bundled: missing Pi SDK under node_modules (run npm ci)");
  process.exit(1);
}

const root = mkdtempSync(path.join(tmpdir(), "piforge-bundled-host-"));
const hostDir = path.join(root, "agent-host");
// 顺序对齐 ensure-standalone-agent-host：先编译树，再 bundle（bundle 里带 assets）。
cpSync(distDir, hostDir, { recursive: true });
cpSync(bundleDir, hostDir, { recursive: true });
writeFileSync(
  path.join(hostDir, "index.js"),
  `import { existsSync } from "node:fs";
import { join } from "node:path";

const sdkDir = ${JSON.stringify(sdkDir)};
if (!process.env.PI_PACKAGE_DIR && existsSync(join(sdkDir, "package.json"))) {
  process.env.PI_PACKAGE_DIR = sdkDir;
}

await import("./host.mjs");
`,
  "utf8",
);

try {
  const result = spawnSync(process.execPath, [path.join(scriptsDir, "smoke-extension-ui-bridge.mjs")], {
    cwd: projectRoot,
    stdio: "inherit",
    env: { ...process.env, PIFORGE_HOST_ENTRY: path.join(hostDir, "index.js") },
    windowsHide: true,
  });
  if (result.error) {
    console.error(`smoke-extension-ui-bundled: failed to start smoke: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(
      "smoke-extension-ui-bundled: bundled Host does not load extensions — " +
        "check that scripts/bundle-agent-host.mjs still defines PI_BUNDLED_NODE",
    );
  }
  process.exit(result.status ?? 1);
} finally {
  rmSync(root, { recursive: true, force: true });
}
