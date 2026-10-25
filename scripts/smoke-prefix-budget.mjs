#!/usr/bin/env node
/**
 * 前缀预算 + 缓存命中率 + 按需域机制的回归护栏。
 *
 * 两种配置各跑一次 measure-prefix：
 *   1. 默认（codemode `only`，普通工具不声明）：前缀 ≤ 7600 tok、稳定段命中率 ≥ 90%、
 *      无「非预期前缀变化」；
 *   2. 工具声明模式（`--codemode off`）下验按需域：`PIFORGE_ON_DEMAND_DOMAINS=1` 时
 *      `tool_search` 能激活 memory / orchestrator，激活后连续两轮 prefixHash 一致。
 *
 * 按需域 / 声明集合类断言一律带 `--codemode off`：应用默认是 codemode `only`，
 * 那个模式下普通工具本来就不在声明集合里，断言会退化成恒真而失去护栏作用。
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

// 默认配置（用户开箱即得的状态）：codemode `only`，声明集合只有 codemode + tool_search。
// 7433 tok 是现网实测值（sys 4313 + tools 3120），留 ~2% 余量；涨过 7600 就是真回归。
const budget = await run([
  "--mode",
  "host",
  "--max-prefix",
  "7600",
  "--assert-hit-rate",
  "90",
  "--max-median-input",
  "200",
  "--assert-lean-transcript",
  "--assert-declared",
  "codemode",
  "--turns",
  "4",
]);
if (budget !== 0) process.exit(budget);

// 设置项驱动的配置（不设环境变量，走 desktop-settings.json 的 onDemandDomains）。
// 必须关掉 codemode：不关的话 shell 是「本来就不声明」，断言等于没测。
const settingsDriven = await run([
  "--mode",
  "host",
  "--turns",
  "2",
  "--codemode",
  "off",
  "--on-demand-settings",
  "shell",
  "--assert-undeclared",
  "shell",
]);
if (settingsDriven !== 0) process.exit(settingsDriven);

// 全常驻（A 组）：环境变量 =0，shell 必须重新被声明。
const allDeclared = await run(
  ["--mode", "host", "--turns", "2", "--codemode", "off", "--assert-declared", "shell"],
  { PIFORGE_ON_DEMAND_DOMAINS: "0" }
);
if (allDeclared !== 0) process.exit(allDeclared);

// 默认配置下唯一按需的域：shell。探针同时验证命名对齐 + 激活后棘轮（measure-prefix 内断言）。
const shellActivation = await run([
  "--mode",
  "host",
  "--turns",
  "3",
  "--codemode",
  "off",
  "--probe-search",
  "shell",
]);
if (shellActivation !== 0) process.exit(shellActivation);

const activation = await run(
  ["--mode", "host", "--turns", "3", "--codemode", "off", "--probe-search", "memory"],
  { PIFORGE_ON_DEMAND_DOMAINS: "1" }
);
if (activation !== 0) process.exit(activation);

const orchestrator = await run(
  ["--mode", "host", "--turns", "3", "--codemode", "off", "--probe-search", "orchestrator"],
  { PIFORGE_ON_DEMAND_DOMAINS: "1" }
);
process.exit(orchestrator);
