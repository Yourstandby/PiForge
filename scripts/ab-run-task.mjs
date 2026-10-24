#!/usr/bin/env node
/**
 * A/B 的**执行内核**：把一道题在真实 Agent Host 上跑一遍，产出可比较的一行结果。
 *
 * 被 `scripts/ab-context-eval.mjs --run` 调用（那里负责分组、轮次、汇总、判据）。
 * 单独也能用，便于排障：
 *
 *   node scripts/ab-run-task.mjs --task E1-truncation-notice --arm control
 *
 * 一次 run 做的事：
 *   1. `git worktree add --detach` 造一个干净工作树（每题一树，互不污染）；
 *   2. 起 Agent Host（**真实** `~/.pi/agent` 配置 → 真实模型），hello 握手；
 *   3. `agent.create` 带题目 prompt（agentMode=full / toolPreset=default，与日常一致）；
 *   4. 轮询 `agent.state.isStreaming` 等到收尾（含超时中止）；
 *   5. 从 `agent.state.sessionFile` 读会话 JSONL，按 `message.usage` 算：
 *      cacheRead 中位 / 调用次数 / 未命中 input 占比 / 成本；
 *   6. 在**同一工作树**里跑该题的 check 判定 pass/fail；
 *   7. 写一行 JSON（默认 `tmp/ab-runs/<arm>__r<round>__<task>.json`）。
 *
 * A/B 的对照组只差一个环境变量（`PIFORGE_TOOL_OUTPUT_CHARS`），其余完全一致。
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST_ENTRY = path.join(repoRoot, "agent-host", "dist", "agent-host", "index.js");
const TASKS_FILE = path.join(repoRoot, "scripts", "ab-context-tasks.json");

/** 各实验臂：只有这些环境变量不同。 */
export const ARMS = {
  control: {},
  "L-D": { PIFORGE_TOOL_OUTPUT_CHARS: "2000" },
  "L-B": { PIFORGE_SESSION_SPLIT_HINT: "1" },
  "L-D+L-B": { PIFORGE_TOOL_OUTPUT_CHARS: "2000", PIFORGE_SESSION_SPLIT_HINT: "1" },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function loadTasks() {
  const parsed = JSON.parse(readFileSync(TASKS_FILE, "utf8"));
  return parsed.tasks;
}

// ---------------------------------------------------------------------------
// 工作树
// ---------------------------------------------------------------------------
export function createWorktree(label) {
  const dir = path.join(tmpdir(), `piforge-ab-${label}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`);
  execFileSync("git", ["worktree", "add", "--detach", dir, "HEAD"], { cwd: repoRoot, stdio: "ignore" });
  linkNodeModules(dir);
  return dir;
}

function linkNodeModules(dir) {
  const modules = path.join(repoRoot, "node_modules");
  const link = path.join(dir, "node_modules");
  if (!existsSync(modules) || existsSync(link)) return;
  try {
    if (process.platform === "win32") execFileSync("cmd", ["/c", "mklink", "/J", link, modules], { stdio: "ignore" });
    else execFileSync("ln", ["-s", modules, link], { stdio: "ignore" });
  } catch {
    // 拿不到 node_modules 不致命（大部分题只读文件；跑 npm/tsc 的题会失败并被如实记录）
  }
}

export function removeWorktree(dir) {
  try {
    execFileSync("git", ["worktree", "remove", "--force", dir], { cwd: repoRoot, stdio: "ignore" });
  } catch {
    try {
      execFileSync("cmd", ["/c", "rmdir", "/S", "/Q", dir], { stdio: "ignore" });
    } catch {
      // 留个残留目录不影响结果
    }
  }
}

// ---------------------------------------------------------------------------
// check 判定（与 --selfcheck 用同一个求值函数，避免"判据两套实现"）
// ---------------------------------------------------------------------------
export function evaluateCheck(check, workdir) {
  const target = path.join(workdir, check.path ?? "");
  const exists = existsSync(target);
  switch (check.type) {
    case "file-contains":
    case "file-matches": {
      if (!exists) return false;
      const content = readFileSync(target, "utf8");
      return check.type === "file-contains" ? content.includes(check.text) : new RegExp(check.regex).test(content);
    }
    case "file-absent":
      return !exists;
    case "json-field":
    case "json-fields":
    case "json-field-at-least": {
      if (!exists) return false;
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(target, "utf8"));
      } catch {
        return false;
      }
      if (check.type === "json-field") return parsed?.[check.field] === check.equals;
      if (check.type === "json-field-at-least") {
        const value = parsed?.[check.field];
        return typeof value === "number" && value >= check.min;
      }
      return Object.entries(check.fields ?? {}).every(([key, expected]) => parsed?.[key] === expected);
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// 会话 JSONL → 用量指标
// ---------------------------------------------------------------------------
export function readUsage(sessionFile) {
  const usage = { calls: 0, cacheRead: [], input: [], output: [], cost: 0, reasoning: 0 };
  if (!sessionFile || !existsSync(sessionFile)) return finalize(usage);
  for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (!message || message.role !== "assistant") continue;
    const raw = message.usage;
    if (!raw || typeof raw.input !== "number" || (raw.totalTokens ?? 0) === 0) continue;
    usage.calls += 1;
    usage.cacheRead.push(raw.cacheRead ?? 0);
    usage.input.push(raw.input ?? 0);
    usage.output.push(raw.output ?? 0);
    usage.reasoning += raw.reasoning ?? 0;
    usage.cost += raw.cost?.total ?? 0;
  }
  return finalize(usage);
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

function finalize(usage) {
  const inputTotal = usage.input.reduce((sum, value) => sum + value, 0);
  const cacheTotal = usage.cacheRead.reduce((sum, value) => sum + value, 0);
  return {
    calls: usage.calls,
    cacheReadMedianPerCall: median(usage.cacheRead),
    cacheReadP90PerCall: (() => {
      if (usage.cacheRead.length === 0) return 0;
      const sorted = [...usage.cacheRead].sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
    })(),
    cacheReadTotal: cacheTotal,
    /** 未命中占比：input / (input + cacheRead)。越高说明"每次都在付全价"。 */
    inputMissRatio: inputTotal + cacheTotal > 0 ? Number((inputTotal / (inputTotal + cacheTotal)).toFixed(4)) : 0,
    outputTotal: usage.output.reduce((sum, value) => sum + value, 0),
    reasoningTotal: usage.reasoning,
    cost: Number(usage.cost.toFixed(6)),
  };
}

// ---------------------------------------------------------------------------
// Host 进程 + RPC
// ---------------------------------------------------------------------------
function createEndpoint() {
  if (process.platform === "win32") return `\\\\.\\pipe\\piforge-ab-${randomBytes(8).toString("hex")}`;
  return path.join(tmpdir(), `piforge-ab-${process.pid}-${randomBytes(4).toString("hex")}.sock`);
}

function startHost({ env, log }) {
  const endpoint = createEndpoint();
  const token = randomBytes(32).toString("hex");
  const child = spawn(process.execPath, [HOST_ENTRY], {
    cwd: repoRoot,
    env: { ...process.env, ...env, PIFORGE_AGENT_ENDPOINT: endpoint, PIFORGE_AGENT_TOKEN: token },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => log(String(chunk)));
  child.stderr.on("data", (chunk) => log(String(chunk)));
  return { child, endpoint, token };
}

function waitForReady(child, log, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("host did not become ready")), timeoutMs);
    const check = () => {
      if (log.text.includes("[agent-host] ready")) {
        clearTimeout(timer);
        resolve();
        return true;
      }
      return false;
    };
    child.stdout.on("data", () => check());
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`host exited before ready (code ${code})\n${log.text.slice(-3000)}`));
    });
    check();
  });
}

function connectClient(endpoint, token) {
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint);
    let buffer = "";
    const frames = [];
    const waiters = [];
    const deliver = (frame) => {
      if (frame.kind === "ping") {
        socket.write(`${JSON.stringify({ kind: "pong", nonce: frame.nonce })}\n`);
        return;
      }
      const waiter = waiters.shift();
      if (waiter) waiter(frame);
      else frames.push(frame);
    };
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) {
          try {
            deliver(JSON.parse(line));
          } catch {
            // 忽略半帧
          }
        }
      }
    });
    socket.once("connect", () => {
      let nextId = 1;
      const next = (timeoutMs = 120_000) => {
        if (frames.length > 0) return Promise.resolve(frames.shift());
        return new Promise((resolveNext, rejectNext) => {
          const timer = setTimeout(() => rejectNext(new Error("timed out waiting for a frame")), timeoutMs);
          waiters.push((frame) => {
            clearTimeout(timer);
            resolveNext(frame);
          });
        });
      };
      resolve({
        socket,
        async call(method, params, timeoutMs = 120_000) {
          const id = nextId++;
          socket.write(`${JSON.stringify({ kind: "req", id, method, params })}\n`);
          for (;;) {
            const frame = await next(timeoutMs);
            if (frame.kind === "res" && frame.id === id) return frame;
          }
        },
        async hello() {
          socket.write(`${JSON.stringify({ kind: "hello", protocolVersion: 1, token, client: { pid: process.pid, role: "cli" } })}\n`);
          for (;;) {
            const frame = await next(30_000);
            if (frame.kind === "hello_ok") return frame;
            if (frame.kind === "hello_error") throw new Error(`handshake failed: ${JSON.stringify(frame)}`);
          }
        },
        close() {
          socket.destroy();
        },
      });
    });
    socket.once("error", reject);
  });
}

/**
 * 跑一道题。返回一行结果（也会被 `--run` 汇总）。
 * `timeoutMs`：整题墙钟上限；超时先 `agent.abort` 再 destroy，结果标记 `timedOut`。
 */
export async function runTask({ task, arm, round, timeoutMs = 8 * 60_000, outDir, verbose = false }) {
  const env = ARMS[arm];
  if (!env) throw new Error(`unknown arm: ${arm}`);
  const log = { text: "" };
  const collect = (chunk) => {
    log.text = (log.text + chunk).slice(-20_000);
    if (verbose) process.stderr.write(chunk);
  };

  const workdir = createWorktree(`${arm}-${task.id}`.replace(/[^A-Za-z0-9-]+/g, "").slice(0, 40));
  const startedAt = Date.now();
  const { child, endpoint, token } = startHost({ env, log: collect });
  let sessionId = null;
  let client = null;
  const result = { task: task.id, arm, round, passed: false, timedOut: false, durationMs: 0, error: null };

  try {
    await waitForReady(child, log);
    client = await connectClient(endpoint, token);
    await client.hello();

    const created = await client.call("agent.create", {
      cwd: workdir,
      agentMode: "full",
      toolPreset: "default",
      command: { type: "prompt", message: task.prompt },
    });
    if (!created.ok) throw new Error(`agent.create failed: ${JSON.stringify(created.error ?? created)}`);
    sessionId = created.result.sessionId;

    // 等收尾：isStreaming=false 且连续两次 stats 不再变化（工具循环收尾有抖动）。
    const deadline = startedAt + timeoutMs;
    let stable = 0;
    let lastSignature = "";
    while (Date.now() < deadline) {
      await sleep(1_500);
      const state = await client.call("agent.state", { sessionId }, 60_000);
      const value = state?.result?.state ?? {};
      const signature = `${value.sessionStats?.tokens?.output ?? 0}:${value.sessionStats?.tokens?.cacheRead ?? 0}`;
      if (value.isStreaming === true) {
        stable = 0;
        continue;
      }
      stable = signature === lastSignature ? stable + 1 : 0;
      lastSignature = signature;
      if (stable >= 1) break;
    }
    if (Date.now() >= deadline) {
      result.timedOut = true;
      await client.call("agent.abort", { sessionId }, 30_000).catch(() => undefined);
    }

    const finalState = await client.call("agent.state", { sessionId }, 60_000);
    const sessionFile = finalState?.result?.state?.sessionFile ?? null;
    Object.assign(result, readUsage(sessionFile));
    result.sessionFile = sessionFile ? path.relative(repoRoot, sessionFile) : null;
    result.passed = evaluateCheck(task.check, workdir);
  } catch (error) {
    result.error = String(error?.message ?? error).slice(0, 600);
  } finally {
    if (client) {
      if (sessionId) await client.call("agent.destroy", { sessionId }, 30_000).catch(() => undefined);
      client.close();
    }
    try {
      child.kill();
    } catch {
      // 已退出
    }
    result.durationMs = Date.now() - startedAt;
    result.worktreeLeftBehind = false;
    removeWorktree(workdir);
    if (outDir) {
      mkdirSync(outDir, { recursive: true });
      const file = path.join(outDir, `${arm}__r${round}__${task.id}.json`);
      writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
    }
  }
  return result;
}

// 直接执行：跑单题（排障用）
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const argOf = (flag, fallback) => {
    const index = argv.indexOf(flag);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
  };
  const taskId = argOf("--task", null);
  const arm = argOf("--arm", "control");
  const round = Number(argOf("--round", "1"));
  if (!taskId) {
    console.error("用法: node scripts/ab-run-task.mjs --task <id> [--arm control|L-D] [--round N]");
    process.exit(2);
  }
  const task = loadTasks().find((entry) => entry.id === taskId);
  if (!task) {
    console.error(`未知题目: ${taskId}`);
    process.exit(2);
  }
  const result = await runTask({ task, arm, round, outDir: path.join(repoRoot, "tmp", "ab-runs"), verbose: argv.includes("--verbose") });
  console.log(JSON.stringify(result, null, 2));
}
