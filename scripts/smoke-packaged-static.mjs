#!/usr/bin/env node
/**
 * 打包版冒烟（P1-4 静态直出）：起一个隔离 userData 的实例，断言
 *
 *   1. `resources/static/index.html` 存在，且 `resources/standalone/server.js` **不存在**
 *      （Next 服务已经从安装包里彻底移除）；
 *   2. 渲染进程真的挂上了 Workbench（`PIFORGE_SMOKE_UI=1` 会在主进程日志里写
 *      `Static UI smoke {…}`）；
 *   3. `/api/health` 经 `piforge://` 协议 + 命名管道拿到 Host 的真实响应
 *      （`host: "ok"`），说明"零内部端口"的数据面是通的。
 *
 *   node scripts/smoke-packaged-static.mjs
 *   node scripts/smoke-packaged-static.mjs --exe release/win-unpacked/PiForge.exe
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const exeIndex = args.indexOf("--exe");
const exe = path.resolve(
  exeIndex === -1
    ? process.platform === "win32"
      ? "release/win-unpacked/PiForge.exe"
      : "release/linux-unpacked/piforge"
    : args[exeIndex + 1],
);

const resourcesDir = path.join(path.dirname(exe), "resources");
const staticIndex = path.join(resourcesDir, "static", "index.html");
const nextServer = path.join(resourcesDir, "standalone", "server.js");
const hostEntry = path.join(resourcesDir, "standalone", "agent-host", "index.js");

const problems = [];
if (!existsSync(exe)) problems.push(`缺少可执行文件：${exe}`);
if (!existsSync(staticIndex)) problems.push(`缺少静态直出产物：${staticIndex}`);
if (existsSync(nextServer)) problems.push(`Next server 仍在安装包里：${nextServer}`);
if (!existsSync(hostEntry)) problems.push(`缺少 Agent Host 入口：${hostEntry}`);

if (problems.length > 0) {
  console.error("smoke-packaged-static: 打包产物不符合静态直出布局");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("先跑 `npm run pack`（会依次执行 build:static / build:standalone / electron-builder）。");
  process.exit(1);
}

const userData = mkdtempSync(path.join(tmpdir(), "piforge-smoke-"));
const logPath = path.join(userData, "logs", "main.log");

const child = spawn(exe, [], {
  env: {
    ...process.env,
    PIFORGE_USER_DATA: userData,
    PIFORGE_SMOKE_UI: "1",
    PIFORGE_SMOKE_EXIT: "1",
  },
  stdio: "ignore",
});

const cleanup = () => {
  if (!child.killed) {
    try {
      child.kill();
    } catch {
      // already gone
    }
  }
};

/** 等日志里出现 `Static UI smoke` 的结果行。 */
function waitForSmokeResult(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(logPath)) {
      const text = readFileSync(logPath, "utf8");
      const index = text.lastIndexOf("Static UI smoke");
      if (index !== -1) {
        const tail = text.slice(index);
        // 结果对象跨多行：取到第一个平衡的 `}` 为止（简单计数即可，值里没有嵌套大括号）。
        const open = tail.indexOf("{");
        let depth = 0;
        for (let i = open; i < tail.length; i += 1) {
          if (tail[i] === "{") depth += 1;
          else if (tail[i] === "}") {
            depth -= 1;
            if (depth === 0) return tail.slice(open, i + 1);
          }
        }
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  return null;
}

const resultText = waitForSmokeResult(90_000);
const exitCode = await new Promise((resolve) => {
  const timer = setTimeout(() => {
    cleanup();
    resolve(1);
  }, 5_000);
  child.once("exit", (code) => {
    clearTimeout(timer);
    resolve(code ?? 0);
  });
});

if (!resultText) {
  console.error(`smoke-packaged-static: 渲染进程没有回报冒烟结果（日志：${logPath}）`);
  process.exit(1);
}

const result = JSON.parse(resultText.replace(/'/g, '"'));
const failures = [];
if (result.url !== "piforge://app/") failures.push(`窗口 URL 不是 piforge://app/：${result.url}`);
if (!result.hasComposer) failures.push("Workbench 的输入框没有挂载（renderer 没起来？）");
if (!result.bodyLength || result.bodyLength < 500) failures.push(`页面正文过短：${result.bodyLength}`);
if (result.health?.host !== "ok") failures.push(`/api/health 未打通：${JSON.stringify(result.health)}`);
if (result.sessionsOk !== true) failures.push("/api/sessions 未打通");

console.log("smoke-packaged-static: UI 冒烟结果");
console.log(`  url=${result.url} title=${result.title} bodyLength=${result.bodyLength} hasComposer=${result.hasComposer}`);
console.log(`  /api/health=${JSON.stringify(result.health)} /api/sessions ok=${result.sessionsOk}`);

if (!args.includes("--keep-user-data")) {
  setTimeout(() => rmSync(userData, { recursive: true, force: true }), 300);
}

if (failures.length > 0) {
  console.error("");
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
console.log(`  exit=${exitCode}（PIFORGE_SMOKE_EXIT=1 会主动退出）`);
console.log("smoke-packaged-static: PASS");
