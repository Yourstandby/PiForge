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
import { existsSync, mkdtempSync, openSync, closeSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
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
// 子进程的 stderr 必须留下来：无显示环境/缺少库/沙箱拒绝都是这里先报，
// 但以前 stdio:"ignore" 把它丢掉了，于是 CI 只能看到“没有回报冒烟结果”。
const stderrPath = path.join(userData, "smoke-stderr.log");
const stderrFd = openSync(stderrPath, "w");

/**
 * Linux CI 的额外开关（只影响冒烟这一次启动，不影响发布出去的包）：
 *   - `--no-sandbox`：ubuntu runner 上 chrome-sandbox 没有 setuid，Electron
 *     会以 “SUID sandbox helper binary was found, but is not configured correctly”
 *     直接退出，表现就是“渲染进程没有回报冒烟结果”；
 *   - `--disable-gpu`：xvfb 的虚拟屏没有硬件加速，强制软渲染避开合成器报错。
 */
const platformArgs = process.platform === "linux" ? ["--no-sandbox", "--disable-gpu"] : [];
const child = spawn(exe, platformArgs, {
  env: {
    ...process.env,
    PIFORGE_USER_DATA: userData,
    PIFORGE_SMOKE_UI: "1",
    PIFORGE_SMOKE_EXIT: "1",
  },
  stdio: ["ignore", "ignore", stderrFd],
});

/** 递归列目录（限深度），用于证明“应用根本没启动”vs“启动了但没写日志”。 */
function listTree(dir, depth) {
  const entries = [];
  const walk = (current, level) => {
    if (level > depth || !existsSync(current)) return;
    for (const name of readdirSync(current)) {
      const full = path.join(current, name);
      const isDir = statSync(full).isDirectory();
      entries.push(path.relative(userData, full) + (isDir ? "/" : ""));
      if (isDir) walk(full, level + 1);
    }
  };
  walk(dir, 1);
  return entries.slice(0, 40);
}

function tail(file, lines) {
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8").trimEnd();
  if (!text) return [];
  return text.split("\n").slice(-lines);
}

/** 没拿到结果时把能拿到的一切打出来，否则 CI 又只能报一句“没有回报”。 */
function dumpNoResultDiagnostics(exitInfo) {
  console.error("  可执行文件：" + exe);
  console.error("  userData：" + userData);
  console.error("  子进程：" + exitInfo);

  const logTail = tail(logPath, 30);
  if (logTail === null) {
    console.error("  main.log 不存在 —— 应用没有走到写日志那一步");
    const tree = listTree(userData, 2);
    console.error("  userData 内容：" + (tree.length ? tree.join(", ") : "（空）"));
    if (process.platform !== "win32" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      console.error("  提示：当前环境没有 DISPLAY，Electron 起不来；Linux 需要用 `xvfb-run -a` 包裹");
    }
  } else if (logTail.length === 0) {
    console.error("  main.log 存在但为空（应用刚启动就死了）");
  } else {
    console.error("  main.log 尾部（显示最后 " + String(logTail.length) + " 行）：");
    for (const line of logTail) console.error("    " + line);
  }

  const stderrTail = tail(stderrPath, 20);
  if (stderrTail && stderrTail.length > 0) {
    console.error("  子进程 stderr（最后 20 行）：");
    for (const line of stderrTail) console.error("    " + line);
  }
}

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

const timeoutMs = Number(process.env.PIFORGE_SMOKE_TIMEOUT_MS ?? "") || 90_000;
const resultText = waitForSmokeResult(timeoutMs);
const exitInfo = await new Promise((resolve) => {
  const timer = setTimeout(() => {
    cleanup();
    resolve("超时未退出，已强制结束");
  }, 5_000);
  child.once("error", (error) => {
    clearTimeout(timer);
    resolve("启动失败：" + String(error));
  });
  child.once("exit", (code) => {
    clearTimeout(timer);
    resolve("exit=" + String(code ?? 0));
  });
});
try {
  closeSync(stderrFd);
} catch {
  // already closed
}

if (!resultText) {
  console.error(`smoke-packaged-static: 渲染进程没有回报冒烟结果（${timeoutMs}ms 内未出现 Static UI smoke）`);
  dumpNoResultDiagnostics(exitInfo);
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
  // 白屏诊断：把渲染进程里采到的证据直接写到 CI 日志，
  // 免得只能从被删掉的 userData 里找（这一轮就是这么丢线索的）。
  if (Array.isArray(result.assets) && result.assets.length > 0) {
    console.error("  入口脚本加载情况：");
    for (const asset of result.assets) console.error(`    ${asset}`);
  }
  if (result.bodyHtmlHead) {
    console.error(`  body 片段（${result.bodyHtmlLength} 字节）：${String(result.bodyHtmlHead).slice(0, 400)}`);
  }
  process.exit(1);
}
console.log(`  exit=${exitInfo}（PIFORGE_SMOKE_EXIT=1 会主动退出）`);
console.log("smoke-packaged-static: PASS");
