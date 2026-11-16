#!/usr/bin/env node
/**
 * 前缀预算 + 缓存命中率 + 按需域机制的回归护栏。
 *
 * 三种配置各跑一次 measure-prefix：
 *   1. `--codemode only`（脚本专用形态）：前缀走 bench/prefix-baseline.json 的双阈值
 *      （超 baseline+3% 只告警、+10% 才失败）、稳定段命中率 ≥ 90%、
 *      无「非预期前缀变化」。7600 是按 `only` 实测标定的，所以这里**显式传参**，
 *      不跟随应用默认值（默认已改为 `on`）；
 *   2. 默认（`--codemode on`，普通工具逐条声明）：锁住「默认确实声明了普通工具」，
 *      预算用 `PIFORGE_PREFIX_BUDGET_ON` 注入（本地实测值待补，见文件末尾注释）；
 *   3. 工具声明模式（`--codemode off`）下验按需域：`PIFORGE_ON_DEMAND_DOMAINS=1` 时
 *      `tool_search` 能激活 memory / orchestrator，激活后连续两轮 prefixHash 一致。
 *
 * 按需域 / 声明集合类断言一律带 `--codemode off`（或显式 `only`）：
 * `on` 模式下普通工具本来就声明着，断言会退化成恒真而失去护栏作用。
 *
 * 没构建 agent-host/dist 时直接跳过（CI 里由 build:agent-host 负责）。
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

/**
 * 前缀 token 走 baseline + 双阈值，不再写死一个数字。
 *
 * 写死单一阈值的教训：7660 是按当时实测标定的，加一个 plan 工具（+417 tok）就直接
 * 红叉 —— 而那次增长是对的：工具 schema、提示词都不该为了让护栏通过而删，删了模型
 * 就不会用这个工具，是真降智。所以：
 *   - 超过 baseline x 1.03  -> 只打告警（不挡合并）
 *   - 超过 baseline x 1.10  -> 硬失败（这种量级基本是误改 / 整段复制）
 *   - baseline 在 bench/prefix-baseline.json；有意改动后跑 --update-baseline 刷新
 *   - 另记 prefixHash：哈希变了说明前缀字节整体变了（缓存作废），CI 上提示刷新
 */
const BASELINE_PATH = path.join(repoRoot, "bench", "prefix-baseline.json");
const WARN_RATIO = 1.03;
const FAIL_RATIO = 1.1;

function loadBaseline() {
  try {
    const parsed = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : { cases: {} };
  } catch {
    return { cases: {} };
  }
}

const baseline = loadBaseline();
const updateBaseline =
  process.argv.includes("--update-baseline") || process.env.PIFORGE_PREFIX_UPDATE_BASELINE === "1";
/** 每次实测到的前缀（measure-prefix 用 --record-prefix 写盘，退出后读回）。 */
const measurements = new Map();

/** 用 baseline 派生 --warn-prefix / --max-prefix；没有基线时只记录不设阈值。 */
function guardArgs(key) {
  if (updateBaseline) return [];
  const base = Number(baseline.cases?.[key]?.prefixTokens);
  if (!Number.isFinite(base) || base <= 0) {
    process.stderr.write(`smoke-prefix-budget: ${key} 无 baseline → 本次只记录不设阈值\n`);
    return [];
  }
  return [
    "--warn-prefix",
    String(Math.round(base * WARN_RATIO)),
    "--max-prefix",
    String(Math.round(base * FAIL_RATIO)),
  ];
}

/**
 * 单步硬超时。measure-prefix 自己只在「等 host ready」上有 60s 兜底，链起来仍可能
 * 无声卡几分钟（调用方看不到任何输出，表现就是「bash 卡住了」）。这里给每步一个
 * 明确的期限 + 一行进度，超了就杀掉进程树并以非零码退出。默认 300s 够全量跑。
 */
const STEP_TIMEOUT_MS = Number(process.env.PIFORGE_SMOKE_STEP_TIMEOUT_MS ?? 300_000);

/** Windows 上 child.kill() 只杀 measure-prefix，host 子孙进程会留存，必须整棵树杀。 */
function killTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn(
      path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
      ["/F", "/T", "/PID", String(child.pid)],
      { stdio: "ignore", windowsHide: true }
    );
    killer.once("error", () => {});
    return;
  }
  child.kill("SIGKILL");
}

function run(args, env = {}, key) {
  const label = args.includes("--probe-search")
    ? `probe:${args[args.indexOf("--probe-search") + 1]}`
    : `codemode:${args[args.indexOf("--codemode") + 1] ?? "default"}`;
  const record = key
    ? path.join(tmpdir(), `piforge-prefix-${key.replace(/[^a-z0-9]+/gi, "-")}.json`)
    : null;
  if (record) rmSync(record, { force: true });
  const fullArgs = record ? [...args, "--record-prefix", record] : args;
  const started = Date.now();
  process.stderr.write(`smoke-prefix-budget: ${label} 开始 (${args.join(" ")})\n`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...fullArgs], {
      cwd: repoRoot,
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      process.stderr.write(
        `smoke-prefix-budget: ${label} 超过 ${Math.round(STEP_TIMEOUT_MS / 1000)}s 未结束，终止进程树\n`
      );
      killTree(child);
    }, STEP_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      process.stderr.write(
        `smoke-prefix-budget: ${label} 结束 code=${code ?? "null"}${
          signal ? ` signal=${signal}` : ""
        } (${seconds}s)${timedOut ? " [超时]" : ""}\n`
      );
      if (record) {
        try {
          measurements.set(key, JSON.parse(readFileSync(record, "utf8")));
        } catch {
          // 记录失败不影响判定：阈值仍按 baseline 生效，只是这次不更新基线。
        } finally {
          rmSync(record, { force: true });
        }
      }
      resolve(timedOut ? 124 : (code ?? 1));
    });
  });
}

// 脚本专用形态（`only`）：声明集合只有 codemode + tool_search。
// 阈值来自 bench/prefix-baseline.json（codemode:only），不再写死数字。
// 注意本地 Windows 的 sys 段比 CI 高约 430 tok（平台/路径描述），本地直接跑这条
// 可能触发告警或失败，以 CI 数字为准。
// 应用默认已改为 `on`，所以这里必须显式传 `--codemode only` 才能保住这个基线。
const budget = await run([
  "--mode",
  "host",
  "--codemode",
  "only",
  ...guardArgs("codemode:only"),
  "--assert-hit-rate",
  "90",
  "--max-median-input",
  "200",
  "--assert-lean-transcript",
  "--assert-declared",
  "codemode",
  "--turns",
  "4",
], {}, "codemode:only");
if (budget !== 0) process.exit(budget);

// 应用默认（codemode `on`）：普通工具逐条声明，前缀比 `only` 明显更大。
// 这里先锁行为契约（`bash` 必须在声明集合里），预算等实测值落地后再收紧：
//   node scripts/measure-prefix.mjs --mode host --codemode on --turns 4 --summary
// 把测得的 max prefix 写进 PIFORGE_PREFIX_BUDGET_ON（CI 变量）或直接替换下面的常量。
const onBudget = process.env.PIFORGE_PREFIX_BUDGET_ON?.trim();
const defaultOn = await run([
  "--mode",
  "host",
  "--codemode",
  "on",
  "--turns",
  "4",
  "--assert-declared",
  "bash",
  ...guardArgs("codemode:on"),
  ...(onBudget ? ["--max-prefix", onBudget] : []),
]);
if (defaultOn !== 0) process.exit(defaultOn);

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

// 收尾：要么把实测值写回 baseline，要么在 CI 上提示「前缀哈希变了」。
if (updateBaseline) {
  const next = { ...baseline, cases: { ...(baseline.cases ?? {}) } };
  for (const [key, measured] of measurements) {
    const prefixTokens = Number(measured?.prefixTokens);
    if (!Number.isFinite(prefixTokens) || prefixTokens <= 0) continue;
    next.cases[key] = {
      prefixTokens,
      prefixHash: measured.prefixHash ?? next.cases[key]?.prefixHash ?? null,
    };
  }
  next.updatedAt = new Date().toISOString().slice(0, 10);
  writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
  process.stderr.write(`smoke-prefix-budget: baseline 已更新 → ${BASELINE_PATH}\n`);
} else if (process.platform === "linux" && measurements.size > 0) {
  for (const [key, measured] of measurements) {
    const expected = baseline.cases?.[key]?.prefixHash;
    const actual = measured?.prefixHash;
    if (expected && actual && expected !== actual) {
      process.stderr.write(
        `smoke-prefix-budget: ⚠ ${key} 前缀哈希变了（${expected} → ${actual}）：` +
          "整段前缀缓存会作废。若是有意改提示词 / 工具声明，跑 --update-baseline 刷新。\n"
      );
    }
  }
}

process.exit(orchestrator);
