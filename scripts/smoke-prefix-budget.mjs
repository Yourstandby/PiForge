#!/usr/bin/env node
/**
 * 前缀预算 + 缓存命中率 + 按需域机制的回归护栏。
 *
 * 两种配置各跑一次 measure-prefix：
 *   1. 默认（memory/orchestrator 常驻）：前缀 ≤ 7200 tok、稳定段命中率 ≥ 90%、
 *      无「非预期前缀变化」；
 *   2. PIFORGE_ON_DEMAND_DOMAINS=1：tool_search 能激活 memory / orchestrator，
 *      激活后连续两轮 prefixHash 一致。
 *
 * 没构建 agent-host/dist 时直接跳过（CI 里由 build:agent-host 负责）。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(repoRoot, "agent-host", "dist", "agent-host", "index.js");
if (!existsSync(entry)) {
  console.error(`smoke-prefix-budget: missing ${entry} (run npm run build:agent-host)`);
  process.exit(1);
}

const script = path.join(repoRoot, "scripts", "measure-prefix.mjs");

function run(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: repoRoot,
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

const budget = await run([
  "--mode",
  "host",
  "--max-prefix",
  "7200",
  "--assert-hit-rate",
  "90",
  "--max-median-input",
  "200",
  "--assert-lean-transcript",
  "--assert-undeclared",
  "shell",
  "--turns",
  "4",
]);
if (budget !== 0) process.exit(budget);

// 设置项驱动的配置（不设环境变量，走 desktop-settings.json 的 onDemandDomains）。
const settingsDriven = await run([
  "--mode",
  "host",
  "--turns",
  "2",
  "--on-demand-settings",
  "shell",
  "--assert-undeclared",
  "shell",
]);
if (settingsDriven !== 0) process.exit(settingsDriven);

// 全常驻（A 组）：环境变量 =0，shell 必须重新被声明。
const allDeclared = await run(
  ["--mode", "host", "--turns", "2", "--assert-declared", "shell"],
  { PIFORGE_ON_DEMAND_DOMAINS: "0" }
);
if (allDeclared !== 0) process.exit(allDeclared);

// 默认配置下唯一按需的域：shell。探针同时验证命名对齐 + 激活后棘轮（measure-prefix 内断言）。
const shellActivation = await run(["--mode", "host", "--turns", "3", "--probe-search", "shell"]);
if (shellActivation !== 0) process.exit(shellActivation);

const activation = await run(
  ["--mode", "host", "--turns", "3", "--probe-search", "memory"],
  { PIFORGE_ON_DEMAND_DOMAINS: "1" }
);
if (activation !== 0) process.exit(activation);

const orchestrator = await run(
  ["--mode", "host", "--turns", "3", "--probe-search", "orchestrator"],
  { PIFORGE_ON_DEMAND_DOMAINS: "1" }
);
process.exit(orchestrator);
