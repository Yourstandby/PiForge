#!/usr/bin/env node
/**
 * 冷启动时间线实测（读 Electron 主进程的真实日志，不猜）。
 *
 * 日志是 JSONL（electron/log-format.ts），`Startup timing: <stage>` 的
 * `detail.elapsedMs` 就是从 `app ready` 起算的毫秒数。本脚本取**最后一次启动**
 * 的那一段，打印阶梯并算出关键差值：
 *
 *   app ready → window created     首屏（品牌启动页）出现的时刻
 *   app ready → next server ready  Next standalone 就绪（旧架构的首屏闸门）
 *   app ready → agent host ready   引擎可用（P0 后 ≤10s，P1 后 ≤5s）
 *
 * 用法：
 *   node scripts/measure-startup.mjs
 *   node scripts/measure-startup.mjs --log "C:/Users/me/AppData/Roaming/piforge/logs/main.log"
 *   node scripts/measure-startup.mjs --max-host-ready 10000 --max-window 1500
 *   node scripts/measure-startup.mjs --json
 *
 * 退出码 1 = 超阈值或时间线不完整（说明启动中途失败/重试过）。
 */
import { existsSync, openSync, readSync, fstatSync, closeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

function parseArgs(argv) {
  const args = { log: null, json: false, maxHostReady: null, maxWindow: null, tailBytes: 4 * 1024 * 1024 };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    switch (key) {
      case "--log":
        args.log = next;
        i += 1;
        break;
      case "--json":
        args.json = true;
        break;
      case "--max-host-ready":
        args.maxHostReady = Number(next);
        i += 1;
        break;
      case "--max-window":
        args.maxWindow = Number(next);
        i += 1;
        break;
      case "--tail-mb":
        args.tailBytes = Number(next) * 1024 * 1024;
        i += 1;
        break;
      default:
        if (key.startsWith("-")) {
          console.error(`unknown flag: ${key}`);
          process.exit(2);
        }
    }
  }
  return args;
}

function defaultLogCandidates() {
  const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  if (process.platform === "win32") {
    return [
      path.join(appData, "piforge", "logs", "main.log"),
      path.join(appData, "PiForge", "logs", "main.log"),
    ];
  }
  if (process.platform === "darwin") {
    return [path.join(os.homedir(), "Library", "Logs", "piforge", "main.log")];
  }
  return [path.join(os.homedir(), ".config", "piforge", "logs", "main.log")];
}

/** 只读文件尾部：main.log 会长到上百 MB，整文件读会卡住采样。 */
function readTail(file, bytes) {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

const args = parseArgs(process.argv.slice(2));
const candidates = args.log ? [args.log] : defaultLogCandidates();
const logPath = candidates.find((candidate) => existsSync(candidate));
if (!logPath) {
  console.error(`measure-startup: 找不到 main.log，试过：\n  ${candidates.join("\n  ")}`);
  console.error("用 --log <path> 显式指定（Electron 的 app.getPath('logs')/main.log）。");
  process.exit(2);
}

const lines = readTail(logPath, args.tailBytes).split("\n").filter(Boolean);
const entries = [];
for (const line of lines) {
  try {
    entries.push(JSON.parse(line));
  } catch {
    // 半行（tail 从中间截断）忽略。
  }
}

/** 最后一次启动：从最后一个 "Startup timing: app ready" 开始。 */
const startIndex = entries.map((entry) => String(entry.message ?? "")).lastIndexOf("Startup timing: app ready");
if (startIndex === -1) {
  console.error("measure-startup: 日志里没有 `Startup timing: app ready`（应用还没启动过？）");
  process.exit(2);
}

const run = entries.slice(startIndex);
const startedAt = Date.parse(String(run[0]?.time ?? ""));
const stages = new Map();
/**
 * 时间轴来自两种日志：
 *   - 0.9.x 的 `Startup timing: <stage>`（带 elapsedMs，直接可用）；
 *   - `Agent Host ready`（旧版本没有对应的 Startup timing 行，用绝对时间戳算）。
 */
for (const entry of run) {
  const time = Date.parse(String(entry.time ?? ""));
  const elapsed = Number.isFinite(time) && Number.isFinite(startedAt) ? time - startedAt : NaN;
  const message = String(entry.message ?? "");
  if (message.startsWith("Startup timing: ")) {
    const stage = message.slice("Startup timing: ".length);
    const value = Number(entry.detail?.elapsedMs);
    stages.set(stage, Number.isFinite(value) ? value : elapsed);
    continue;
  }
  if (message === "Agent Host ready" && !stages.has("agent host ready") && Number.isFinite(elapsed)) {
    stages.set("agent host ready", elapsed);
  }
}

const problems = [];
for (const entry of run) {
  const message = String(entry.message ?? "");
  if (message.includes("Agent Host failed to become ready")) {
    problems.push(`Agent Host 在 ${JSON.stringify(entry.detail)} 时被判定失败（旧行为会 kill + 重启）`);
  }
  if (message.includes("Agent Host exited before becoming ready")) {
    problems.push(`Host 在就绪前就退出了：${JSON.stringify(entry.detail)}（崩溃，非超时）`);
  }
  if (message.includes("killing hung process")) {
    problems.push(`Host 硬超时被杀：${JSON.stringify(entry.detail)}`);
  }
  if (message.includes("Agent Host still booting after soft timeout")) {
    problems.push(`Agent Host 超过软超时仍在启动：${JSON.stringify(entry.detail)}`);
  }
  if (message.includes("Scheduling Agent Host restart")) {
    problems.push(`Host 重启退避被触发：${JSON.stringify(entry.detail)}`);
  }
  if (message.includes("heartbeat timeout")) {
    problems.push("Host 心跳超时（浏览器桥没回 pong 的已知缺陷）");
  }
}

const want = [
  "agent host kickoff",
  "port selected",
  "window created",
  "next process spawned",
  "next server ready",
  "loading app url",
  "agent host ready",
];

const timeline = want
  .filter((stage) => stages.has(stage))
  .map((stage) => ({ stage, elapsedMs: stages.get(stage) }));

const report = {
  logPath,
  startedAt: run[0]?.time ?? null,
  timeline,
  appReadyToWindowMs: stages.has("window created") ? stages.get("window created") : null,
  appReadyToNextReadyMs: stages.has("next server ready") ? stages.get("next server ready") : null,
  appReadyToHostReadyMs: stages.has("agent host ready") ? stages.get("agent host ready") : null,
  problems: [...new Set(problems)],
};

const failures = [];
if (report.appReadyToHostReadyMs === null) {
  failures.push("没有 `agent host ready`：这次启动 Host 没就绪（被超时杀掉或仍在启动）");
} else if (args.maxHostReady !== null && report.appReadyToHostReadyMs > args.maxHostReady) {
  failures.push(`app ready → host ready ${report.appReadyToHostReadyMs}ms > 上限 ${args.maxHostReady}ms`);
}
if (args.maxWindow !== null && report.appReadyToWindowMs !== null && report.appReadyToWindowMs > args.maxWindow) {
  failures.push(`app ready → window ${report.appReadyToWindowMs}ms > 上限 ${args.maxWindow}ms`);
}

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`日志：${report.logPath}`);
  console.log(`本次启动：${report.startedAt}`);
  console.log("");
  console.log("阶段                                  elapsed(ms)");
  for (const item of report.timeline) {
    console.log(`${item.stage.padEnd(36)} ${String(item.elapsedMs).padStart(8)}`);
  }
  console.log("");
  const ms = (value) => (value === null ? "—" : `${value}ms`);
  console.log(`app ready → window          ${ms(report.appReadyToWindowMs)}`);
  console.log(`app ready → next ready      ${ms(report.appReadyToNextReadyMs)}`);
  console.log(`app ready → host ready      ${ms(report.appReadyToHostReadyMs)}`);
  if (report.problems.length > 0) {
    console.log("");
    console.log("这次启动里的异常：");
    for (const problem of report.problems) console.log(`  - ${problem}`);
  }
}

if (failures.length > 0) {
  console.error("");
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
