/**
 * 量一下 agent-host 的启动耗时构成（本机实测用，不参与构建）。
 *
 *   node scripts/measure-host-boot.mjs [--label dev|packaged]
 *
 * 默认跑 `agent-host/dist/agent-host/index.js`（dev 布局，依赖从仓库根
 * node_modules 解析）。打包版请用 --entry 指到
 * `release/.../resources/standalone/agent-host/index.js`，两者耗时差很大
 * （dev 的 node_modules 未裁剪，ESM 解析能吃掉十几秒）。
 *
 * 输出：每条 host 日志的相对毫秒 + `host_ready` 的毫秒数。
 */
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { existsSync } from "node:fs";

const args = process.argv.slice(2);
const entryArg = args.indexOf("--entry");
const entry = path.resolve(
  entryArg === -1 ? "agent-host/dist/agent-host/index.js" : args[entryArg + 1],
);
if (!existsSync(entry)) {
  console.error(`missing ${entry} (run npm run build:agent-host)`);
  process.exit(1);
}

/** 用 fromCharCode 避免反斜杠转义把命名管道写坏。 */
const BS = String.fromCharCode(92);
const endpoint =
  process.platform === "win32"
    ? `${BS}${BS}.${BS}pipe${BS}piforge-boot-${process.pid}`
    : path.join(process.env.TMPDIR ?? "/tmp", `piforge-boot-${process.pid}.sock`);

const t0 = performance.now();
const stamp = () => String(Math.round(performance.now() - t0)).padStart(6);
console.log(`[${stamp()}ms] spawn ${entry}`);

const child = spawn(process.execPath, [entry], {
  env: { ...process.env, PIFORGE_AGENT_ENDPOINT: endpoint, PIFORGE_AGENT_TOKEN: "x".repeat(32) },
  // 打包版从 standalone 目录解析依赖（与 Electron utilityProcess 的 cwd 一致）。
  cwd: entry.includes(`${BS}standalone${BS}`) ? path.dirname(path.dirname(entry)) : process.cwd(),
  stdio: ["ignore", "pipe", "pipe"],
});

let readyAt = null;
const feed = (stream, prefix) => {
  stream.on("data", (chunk) => {
    for (const line of chunk.toString().split("\n")) {
      if (!line.trim()) continue;
      console.log(`[${stamp()}ms] ${prefix}${line}`);
      if (line.includes("ready protocol=")) readyAt ??= Math.round(performance.now() - t0);
    }
  });
};
feed(child.stdout, "");
feed(child.stderr, "stderr: ");

const finish = (code) => {
  console.log(`\n== host_ready: ${readyAt === null ? "n/a" : `${readyAt}ms`} ==`);
  try {
    child.kill();
  } catch {
    // already gone
  }
  process.exit(code);
};

const timeout = setTimeout(() => finish(1), 60_000);
child.on("exit", () => {
  clearTimeout(timeout);
  finish(readyAt === null ? 1 : 0);
});
