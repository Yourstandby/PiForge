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
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { defaultTarget, resourcesDirFor } from "./lib/smoke-target.mjs";

const args = process.argv.slice(2);
const exeIndex = args.indexOf("--exe");
const exe = path.resolve(exeIndex === -1 ? defaultTarget() : args[exeIndex + 1]);

const resourcesDir = resourcesDirFor(exe, path);
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
// 子进程输出必须留下来：无显示环境/缺少库/沙箱拒绝都是这里先报，
// 但以前 stdio:"ignore" 把它丢掉了，于是 CI 只能看到“没有回报冒烟结果”。
// stdout 也接：main.log 写不进去的时候（曾经在 macOS 上发生），
// 主进程的 console 输出是唯一能证明“应用其实起来了”的证据。
const stdoutPath = path.join(userData, "smoke-stdout.log");
const stderrPath = path.join(userData, "smoke-stderr.log");
const stdoutFd = openSync(stdoutPath, "w");
const stderrFd = openSync(stderrPath, "w");

/**
 * 日志候选路径。正常情况下 `PIFORGE_USER_DATA` 会把日志目录也挪到隔离目录
 * （electron/main.ts 里显式 setPath("logs")），但 Electron 各平台的 `logs`
 * 默认值不一样（macOS 是 `~/Library/Logs/<app>`），所以再兜几个默认位置，
 * 避免“应用活着但冒烟找不到日志”这类假红。
 */
const logCandidates = [
  logPath,
  ...(process.platform === "darwin"
    ? [
        path.join(homedir(), "Library", "Logs", "PiForge", "main.log"),
        // `app.getName()` 可能拿到 package.json 的 name（小写 piforge），
        // 与 scripts/measure-startup.mjs 的候选保持一致。
        path.join(homedir(), "Library", "Logs", "piforge", "main.log"),
      ]
    : []),
  ...(process.platform === "win32"
    ? [
        path.join(process.env.APPDATA ?? "", "PiForge", "logs", "main.log"),
        path.join(process.env.APPDATA ?? "", "piforge", "logs", "main.log"),
      ]
    : []),
  ...(process.platform === "linux"
    ? [
        path.join(homedir(), ".config", "PiForge", "logs", "main.log"),
        path.join(homedir(), ".config", "piforge", "logs", "main.log"),
      ]
    : []),
].filter((candidate) => candidate.length > 0);

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
  stdio: ["ignore", stdoutFd, stderrFd],
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

/**
 * 从（任意候选路径的）main.log 里摘出渲染进程的证据：`[renderer] ...`
 * （console 转发，含 React 抛错）与 `did-fail-load`（资源 404 / 协议失败 / CSP 拦截）。
 * 正文过短但进程活着时，这两类行就是根因所在。
 */
function rendererConsoleLines(limit = 20) {
  for (const candidate of logCandidates) {
    if (!existsSync(candidate)) continue;
    return readFileSync(candidate, "utf8")
      .split("\n")
      .filter((line) => line.includes("[renderer]") || line.includes("did-fail-load"))
      .slice(-limit);
  }
  return [];
}

/** 没拿到结果时把能拿到的一切打出来，否则 CI 又只能报一句“没有回报”。 */
function dumpNoResultDiagnostics(exitInfo) {
  console.error("  可执行文件：" + exe);
  console.error("  userData：" + userData);
  console.error("  子进程：" + exitInfo);

  const found = logCandidates.filter((candidate) => existsSync(candidate));
  if (found.length === 0) {
    console.error("  main.log 在所有候选位置都不存在 —— 应用没有走到写日志那一步");
    for (const candidate of logCandidates) console.error("    查过：" + candidate);
    const tree = listTree(userData, 2);
    console.error("  userData 内容：" + (tree.length ? tree.join(", ") : "（空）"));
    if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      console.error("  提示：Linux 没有 DISPLAY / X server，Electron 起不来；需要用 `xvfb-run -a` 包裹");
    }
  } else {
    for (const candidate of found) {
      const logTail = tail(candidate, 30);
      if (logTail === null) continue;
      if (logTail.length === 0) {
        console.error("  " + candidate + " 为空（应用刚启动就死了）");
        continue;
      }
      console.error("  " + candidate + " 尾部（最后 " + String(logTail.length) + " 行）：");
      for (const line of logTail) console.error("    " + line);
    }
  }

  // stdout 是主进程 console 的镜像：main.log 写不进去时全靠它。
  const stdoutTail = tail(stdoutPath, 20);
  if (stdoutTail && stdoutTail.length > 0) {
    console.error("  子进程 stdout（最后 20 行）：");
    for (const line of stdoutTail) console.error("    " + line);
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
    for (const candidate of logCandidates) {
      if (!existsSync(candidate)) continue;
      const text = readFileSync(candidate, "utf8");
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
  closeSync(stdoutFd);
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
/**
 * 正文长度门槛：**只作诊断参考，不再是断言**。
 *
 * 老规则“≥ 500 字”在全新用户配置下必然假红：CI runner / 首次启动时应用停在
 * “暂无项目”空状态，正文 150–180 字，而 SSR 空壳也是 160 字左右——两者靠字数
 * 区分不开（v0.9.1 三个平台的假红：DOM 48 KB、12 个 chunk 全 200、正文 181 字）。
 * 真正能区分“前端活着 / 只是没挂载”的是渲染进程打的 `data-piforge-hydrated` 标记。
 * `PIFORGE_SMOKE_MIN_BODY` 可手动下门槛（默认不断言）。
 */
const minBody = Number(process.env.PIFORGE_SMOKE_MIN_BODY ?? "") || 0;
const failures = [];
if (result.url !== "piforge://app/") failures.push(`窗口 URL 不是 piforge://app/：${result.url}`);
if (result.hydrated !== true) failures.push("React 没有 hydrate（data-piforge-hydrated 未置位：入口 JS 未执行或挂载时抛错）");
if (!result.hasComposer) failures.push("Workbench 的输入框没有挂载（renderer 没起来？）");
if (minBody > 0 && (!result.bodyLength || result.bodyLength < minBody)) {
  failures.push(`页面正文过短：${result.bodyLength}（PIFORGE_SMOKE_MIN_BODY=${minBody}）`);
}
if (result.health?.host !== "ok") failures.push(`/api/health 未打通：${JSON.stringify(result.health)}`);
if (result.sessionsOk !== true) failures.push("/api/sessions 未打通");

console.log("smoke-packaged-static: UI 冒烟结果");
console.log(`  url=${result.url} title=${result.title} bodyLength=${result.bodyLength} hydrated=${result.hydrated} hasComposer=${result.hasComposer}`);
console.log(`  /api/health=${JSON.stringify(result.health)} /api/sessions ok=${result.sessionsOk}`);

if (!args.includes("--keep-user-data")) {
  setTimeout(() => rmSync(userData, { recursive: true, force: true }), 300);
}

if (failures.length > 0) {
  console.error("");
  for (const failure of failures) console.error(`FAIL ${failure}`);
  // 白屏诊断：把渲染进程里采到的证据直接写到 CI 日志，
  // 免得只能从被删掉的 userData 里找（这一轮就是这么丢线索的）。
  const rendererLines = rendererConsoleLines();
  if (rendererLines.length > 0) {
    console.error("  渲染进程 console / did-fail-load（最后 " + String(rendererLines.length) + " 条）：");
    for (const line of rendererLines) console.error(`    ${line}`);
  } else {
    console.error("  渲染进程没有输出任何 console / did-fail-load（说明 JS 根本没执行）");
  }
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
