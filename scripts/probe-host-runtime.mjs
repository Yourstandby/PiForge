#!/usr/bin/env node
/**
 * L1 补完的可行性验证：把 Agent Host 从 `utilityProcess` 换成 **ELECTRON_RUN_AS_NODE 子进程**，
 * 看 V8 堆能不能同时收到「新生代 + 老生代」，以及空闲 RSS 是否落到纯 node 水平。
 *
 * 为什么要验证：`utilityProcess.fork()` 的 `execArgv` 只能带**一个** `--js-flags`
 * （多个 V8 flag 用空格分隔时，Electron 重拼命令行会拆开 → 静默失效，见 electron/host-heap.ts）。
 * 所以现在只能收紧老生代（limit 352MB、host RSS 262–290MB），刚好卡在 220MB 目标之上。
 * 而 host 本身是个**命名管道客户端**（脚本 smoke-agent-host 里就用 `node` 直接跑过），
 * 对 Electron 没有运行时依赖 —— 换成普通子进程在传输层是可行的。
 *
 * 本脚本不改任何运行时代码，只做三方对照实测：
 *   A. `node` 直接跑（基线下限）
 *   B. `ELECTRON_RUN_AS_NODE=1` + Electron 二进制（候选方案）
 *   C. 现有的 `utilityProcess`（用打包版 App 启动，读它自己打印的 limitMb / RSS）
 *
 * 用法：
 *   node scripts/probe-host-runtime.mjs                 # A + B
 *   node scripts/probe-host-runtime.mjs --with-utility  # 追加 C（需要打包版，约 40s）
 *   node scripts/probe-host-runtime.mjs --json
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { hostChildEnv } from "./lib/host-spawn.mjs";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hostEntry = path.join(repoRoot, "agent-host", "dist", "agent-host", "index.js");
/** 目标参数：老生代 256 + 新生代 8（旧生代 256 时 V8 实际 limit ≈ 280–352MB，见报告）。 */
const HEAP_FLAGS = "--max-old-space-size=256 --max-semi-space-size=8";
const SAMPLE_MS = 8_000;
const TIMEOUT_MS = 30_000;

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");


if (!existsSync(hostEntry)) {
  console.error(`probe-host-runtime: missing ${hostEntry} (run npm run build:agent-host)`);
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createEndpoint() {
  if (process.platform === "win32") return `\\\\.\\pipe\\piforge-probe-${randomBytes(8).toString("hex")}`;
  const dir = mkdtempSync(path.join(tmpdir(), "piforge-probe-"));
  return path.join(dir, "host.sock");
}

/** PowerShell 取进程 RSS（KB）；进程已退出则返回 null。 */
function readRssKb(pid) {
  const out = powershell(
    `Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty WorkingSet64`,
  );
  const value = Number(String(out).trim().split(/\r?\n/).pop());
  // WorkingSet64 是字节；这里直接给 MB，避免"看起来 138928 MB"这种单位事故。
  return Number.isFinite(value) && value > 0 ? Math.round(value / 1024 / 1024) : null;
}

/** 单次 PowerShell（Windows 上取 RSS / 查进程命令行都走它，避免额外依赖）。 */
function powershell(script) {
  try {
    return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
    });
  } catch {
    return "";
  }
}

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let output = "";
    const timer = setTimeout(() => finish(new Error("host did not report ready")), TIMEOUT_MS);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(Object.assign(error, { output }));
      else resolve(output);
    };
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      if (output.includes("[agent-host] ready")) finish(null);
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.once("exit", (code) => finish(new Error(`host exited before ready (code ${code})`)));
    child.once("error", (error) => finish(error));
  });
}

function connectClient(endpoint) {
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint);
    let buffer = "";
    const pending = [];
    const waiters = [];
    const deliver = (frame) => {
      if (frame.kind === "ping") {
        socket.write(`${JSON.stringify({ kind: "pong", nonce: frame.nonce })}\n`);
        return;
      }
      const waiter = waiters.shift();
      if (waiter) waiter(frame);
      else pending.push(frame);
    };
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) deliver(JSON.parse(line));
      }
    });
    socket.once("connect", () => {
      const next = () => {
        if (pending.length > 0) return Promise.resolve(pending.shift());
        return new Promise((resolveNext, rejectNext) => {
          const timer = setTimeout(() => rejectNext(new Error("timed out waiting for a frame")), TIMEOUT_MS);
          waiters.push((frame) => {
            clearTimeout(timer);
            resolveNext(frame);
          });
        });
      };
      resolve({
        socket,
        send(frame) {
          socket.write(`${JSON.stringify(frame)}\n`);
        },
        async waitFor(predicate) {
          for (;;) {
            const frame = await next();
            if (predicate(frame)) return frame;
          }
        },
      });
    });
    socket.once("error", reject);
  });
}

/** 从 host 自己的启动日志里读真实 heap limit（它会打印 v8.getHeapStatistics）。 */
function parseHeapLimit(output) {
  const match = output.match(/limitMb=(\d+(?:\.\d+)?)/);
  return match ? Math.round(Number(match[1])) : null;
}

async function measure({ label, command, args, env, cwd }) {
  const endpoint = createEndpoint();
  const token = randomBytes(32).toString("hex");
  const sandbox = mkdtempSync(path.join(tmpdir(), "piforge-probe-user-"));
  const agentDir = path.join(sandbox, "agent");
  mkdirSync(agentDir, { recursive: true });

  const startedAt = Date.now();
  const child = spawn(command, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    // 这里 spawn 的可能是 electron 二进制 / utilityProcess 包装，不是 node 自身，
    // 所以不走 spawnNodeHost()；但 env 护栏必须走同一个 helper，别再手写。
    env: hostChildEnv({
      ...env,
      PI_CODING_AGENT_DIR: agentDir,
      PIFORGE_AGENT_ENDPOINT: endpoint,
      PIFORGE_AGENT_TOKEN: token,
    }),
  });

  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });

  const result = { label, command: args[0] ?? command, readyMs: null, heapLimitMb: null, rssSamples: [], health: null };
  try {
    await waitForReady(child);
    result.readyMs = Date.now() - startedAt;
    result.heapLimitMb = parseHeapLimit(output);

    const client = await connectClient(endpoint);
    client.send({
      kind: "hello",
      protocolVersion: 1,
      token,
      client: { pid: process.pid, role: "cli" },
    });
    const hello = await client.waitFor((frame) => frame.kind === "hello_ok" || frame.kind === "hello_error");
    assert.equal(hello.kind, "hello_ok", `${label}: expected hello_ok`);
    // 帧格式来自 contract/guards.ts：请求是 `{kind:"req", id:<number>}`，响应 `{kind:"res"}`。
    client.send({ kind: "req", id: 1, method: "host.health", params: {} });
    const health = await client.waitFor((frame) => frame.kind === "res" && frame.id === 1);
    result.health = health.result?.ok ?? null;

    // 空闲采样：与 measure-packaged 同口径（稳定后取中位/最大）。
    await sleep(3_000);
    const deadline = Date.now() + SAMPLE_MS;
    while (Date.now() < deadline) {
      const rss = readRssKb(child.pid);
      if (rss) result.rssSamples.push(rss);
      await sleep(1_000);
    }
    client.socket.destroy();
  } catch (error) {
    // 失败时把 host 自己的输出带出来，否则只看到 "timed out waiting for a frame"。
    error.message += `
--- host output ---
${output.slice(-2000)}`;
    throw error;
  } finally {
    try {
      child.kill();
    } catch {
      // 已退出
    }
    await sleep(300);
    rmSync(sandbox, { recursive: true, force: true });
  }

  const samples = [...result.rssSamples].sort((a, b) => a - b);
  result.rssMedianMb = samples.length > 0 ? samples[Math.floor(samples.length / 2)] : null;
  result.rssMaxMb = samples.length > 0 ? samples[samples.length - 1] : null;
  delete result.rssSamples;
  return result;
}

/**
 * 对照组（现状 = utilityProcess）不在这里测：
 * 它必须让整个 App 起来，用 `node scripts/measure-packaged.mjs --exe release/win-unpacked/PiForge.exe`
 * 才是同一口径（同一个采样器）。本脚本只负责"同一份 dist 用不同宿主跑"的对比。
 */
function controlRowFromDocs() {
  return {
    label: "utilityProcess（现状）",
    heapLimitMb: 352,
    rssMedianMb: 265.6,
    note: "measure-packaged.mjs 实测（打包版，空闲）",
  };
}

async function main() {
  const electronBinary =
    process.platform === "win32"
      ? path.join(repoRoot, "node_modules", "electron", "dist", "electron.exe")
      : path.join(repoRoot, "node_modules", "electron", "dist", "electron");

  const runs = [];
  runs.push(
    await measure({
      label: "node（基线下限）",
      command: process.execPath,
      args: [hostEntry],
      env: { NODE_OPTIONS: HEAP_FLAGS },
      cwd: repoRoot,
    }),
  );
  if (existsSync(electronBinary)) {
    runs.push(
      await measure({
        label: "ELECTRON_RUN_AS_NODE=1（候选）",
        command: electronBinary,
        args: [hostEntry],
        env: { ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: HEAP_FLAGS },
        cwd: repoRoot,
      }),
    );
  }
  const control = controlRowFromDocs();

  if (asJson) {
    console.log(JSON.stringify({ heapFlags: HEAP_FLAGS, runs }, null, 2));
    return;
  }

  console.log(`L1 传输层验证（HEAP_FLAGS="${HEAP_FLAGS}"，空闲采样 ${SAMPLE_MS / 1000}s）\n`);
  console.log("| 运行方式 | heap limit (MB) | 空闲 RSS 中位 (MB) | 空闲 RSS 最大 (MB) | ready (ms) | health |");
  console.log("|---|---|---|---|---|---|");
  console.log(
    `| ${control.label} | ${control.heapLimitMb} | ${control.rssMedianMb} | — | — | ok（${control.note}） |`,
  );
  for (const run of runs) {
    if (run.skipped) {
      console.log(`| ${run.label} | — | — | — | — | 跳过：${run.skipped} |`);
      continue;
    }
    console.log(
      `| ${run.label} | ${run.heapLimitMb ?? "n/a"} | ${run.rssMedianMb ?? "n/a"} | ${run.rssMaxMb ?? "n/a"} | ${run.readyMs ?? "n/a"} | ${run.health === true ? "ok" : "fail"} |`,
    );
  }
  const candidate = runs.find((run) => run.label.startsWith("ELECTRON_RUN_AS_NODE"));
  if (candidate) {
    const ok = (candidate.rssMedianMb ?? Infinity) <= 195;
    console.log(
      `\n结论：候选方案空闲 RSS 中位 ${candidate.rssMedianMb} MB、heap limit ${candidate.heapLimitMb} MB → ` +
        (ok ? "达到 195 MB 目标，值得立项。" : "未达到 195 MB，按不及格处理。"),
    );
  }
}

await main();
