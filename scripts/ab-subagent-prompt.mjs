#!/usr/bin/env node
/**
 * 子 Agent 提示词对照实验（旧提示词 vs 新 JSON 契约）。**本轮只交付脚本，不跑正式对照。**
 *
 * 目的：验证两条新约束（diff 必须可应用 / JSON 只管最终回复）到底有没有效果，还是只是"看起来更规范"。
 *
 * 设计：
 *   - 同一个可机检任务（默认：修一个坏掉的断言，验收 `node --test` 通过）；
 *   - 两臂只差一件事：子 Agent 的 system prompt 变体（`PIFORGE_SUBAGENT_PROMPT=legacy|contract`）；
 *   - 每臂 3 次，每次在**独立 git worktree** 里跑（互不污染），
 *     用**独立 agent 目录 + PIFORGE_SESSION_DIR**（不写共享 `~/.pi/agent/sessions`）；
 *   - 采集：输出 token、总成本、任务成功率、**补丁是否可 `git apply`**（= 是否需要人工补丁）。
 *
 * 判据：
 *   1. `contract` 臂的输出 token 相对 `legacy` 下降 ≥30%；
 *   2. 成功率不下降；
 *   3. 需要人工补丁的次数 = 0（`legacy` 臂允许出现，这正是它的问题）。
 *
 * 用法：
 *   node scripts/ab-subagent-prompt.mjs --plan      # 默认：只打印方案与预算，不花 token
 *   node scripts/ab-subagent-prompt.mjs --selfcheck # 自检判据（不花 token）：坏 → 好，且好补丁能 git apply
 *   node scripts/ab-subagent-prompt.mjs --run --spend
 *   node scripts/ab-subagent-prompt.mjs --report tmp/ab-subagent-prompt
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const argOf = (flag, fallback) => {
  const index = argv.indexOf(flag);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const ARMS = ["legacy", "contract"];
const RUNS_PER_ARM = Number(argOf("--runs", "3"));
const OUT_DIR = path.isAbsolute(argOf("--out", ""))
  ? argOf("--out", "")
  : path.join(repoRoot, "tmp", "ab-subagent-prompt");

/**
 * 判分用的可机检任务：在一份**故意坏掉**的 fixture 上做最小修改。
 * fixture 内容随 worktree 生成，不依赖仓库现有文件（避免仓库改动让实验失效）。
 */
export const TASK = {
  id: "fix-guard-threshold",
  /** 任务提示词：两臂完全相同。 */
  prompt: [
    "任务：修复 `fixture/guards.mjs` 里的 off-by-one 错误。",
    "",
    "- 文件里有 `shouldStop(rounds, limit)`，现在当 `rounds === limit` 时返回 false，",
    "  导致「达到阈值仍不停」。期望语义：`rounds >= limit` 时返回 true。",
    "- 同目录 `fixture/guards.test.mjs` 是验收测试（现在失败）。",
    "- 验收：`node --test fixture/guards.test.mjs` 全部通过。",
    "- 只改 `fixture/guards.mjs`，不要改测试文件。",
  ].join("\n"),
  /** 验收命令（在 worktree 里执行，退出码 0 = 成功）。 */
  verify: { command: process.execPath, args: ["--test", "fixture/guards.test.mjs"] },
  /** 会被改动、用于做 diff 检测的文件。 */
  touchedFile: "fixture/guards.mjs",
};

const FIXTURE_SOURCE = `/**
 * 空转熔断的判定（fixture 用）。语义：达到阈值就该停。
 */
export function shouldStop(rounds, limit) {
  // BUG: off-by-one —— 达到阈值时会返回 false
  return rounds > limit;
}

export function describe(rounds, limit) {
  return shouldStop(rounds, limit) ? \`stop after \${rounds}\` : \`keep going (\${rounds}/\${limit})\`;
}
`;

const FIXTURE_TEST = `import test from "node:test";
import assert from "node:assert/strict";
import { shouldStop, describe } from "./guards.mjs";

test("达到阈值就该停", () => {
  assert.equal(shouldStop(5, 5), true);
});

test("超过阈值当然要停", () => {
  assert.equal(shouldStop(6, 5), true);
});

test("未达阈值继续跑", () => {
  assert.equal(shouldStop(4, 5), false);
});

test("describe 跟着判定走", () => {
  assert.equal(describe(5, 5), "stop after 5");
});
`;

/** 预算假设（与 context-governance-ab.md 同源：实测均值成本/调用）。 */
const BASELINE_COST_PER_CALL = 0.0022;
const ASSUMED_CALLS_PER_RUN = 8;

function ensureFixtureWorktree(label) {
  const dir = path.join(tmpdir(), `piforge-absp-${label}-${Date.now().toString(36)}`);
  execFileSync("git", ["worktree", "add", "--detach", dir, "HEAD"], { cwd: repoRoot, stdio: "ignore" });
  mkdirSync(path.join(dir, "fixture"), { recursive: true });
  writeFileSync(path.join(dir, "fixture", "guards.mjs"), FIXTURE_SOURCE);
  writeFileSync(path.join(dir, "fixture", "guards.test.mjs"), FIXTURE_TEST);
  return dir;
}

function removeWorktree(dir) {
  try {
    execFileSync("git", ["worktree", "remove", "--force", dir], { cwd: repoRoot, stdio: "ignore" });
  } catch {
    // 残留目录不影响结果
  }
}

/** 独立 agent 目录：复用真实 auth/models，但把会话落到隔离目录。 */
export function prepareIsolatedAgentDir() {
  const dir = path.join(tmpdir(), "piforge-absp-agent");
  mkdirSync(dir, { recursive: true });
  const home = path.join(homedir(), ".pi", "agent");
  for (const name of ["auth.json", "models.json", "models-shared.json", "settings.json", "trust.json"]) {
    const from = path.join(home, name);
    const to = path.join(dir, name);
    if (existsSync(from) && !existsSync(to)) writeFileSync(to, readFileSync(from));
  }
  return dir;
}

/**
 * 从子 Agent 的最终回复里取补丁并试 `git apply`。
 * 三种情况：给了 ```diff 围栏 / 裸 unified diff / 什么都没给（散文描述 = 需人工补丁）。
 */
export function extractPatch(text) {
  if (typeof text !== "string" || text.length === 0) return { patch: null, source: "empty" };
  const fenced = text.match(/```(?:diff|patch)?\n([\s\S]*?)```/);
  if (fenced && fenced[1].includes("diff --git")) return { patch: fenced[1], source: "fenced" };
  const bare = text.match(/^diff --git[\s\S]*$/m);
  if (bare) return { patch: bare[0], source: "bare" };
  const jsonPatch = text.match(/"patch"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (jsonPatch) {
    try {
      return { patch: JSON.parse(`"${jsonPatch[1]}"`), source: "json_field" };
    } catch {
      // 落到下面
    }
  }
  return { patch: null, source: "prose" };
}

/** `git apply --check` 是否成功（= 补丁可直接落地，无需人工重写）。 */
export function canApplyPatch(workdir, patch) {
  if (!patch) return false;
  const file = path.join(tmpdir(), `absp-patch-${Date.now().toString(36)}.diff`);
  writeFileSync(file, patch.endsWith("\n") ? patch : `${patch}\n`);
  try {
    execFileSync("git", ["apply", "--check", file], { cwd: workdir, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * 自检（不花 token）：证明"判据本身"是对的。
 *   1. fixture 初始必须是**红的**（改动没做时验收失败）；
 *   2. 一份**正确的** unified diff 必须能 `git apply`，且 apply 后验收变绿；
 *   3. 一份错误的 patch（上下文不对）必须被 `canApplyPatch` 判否 —— 否则"人工补丁"这个指标就是假的。
 */
function selfcheck() {
  const workdir = ensureFixtureWorktree("selfcheck");
  const goodPatch = [
    "diff --git a/fixture/guards.mjs b/fixture/guards.mjs",
    "--- a/fixture/guards.mjs",
    "+++ b/fixture/guards.mjs",
    "@@ -3,6 +3,6 @@",
    " export function shouldStop(rounds, limit) {",
    "   // BUG: off-by-one —— 达到阈值时会返回 false",
    "-  return rounds > limit;",
    "+  return rounds >= limit;",
    " }",
    "",
    " export function describe(rounds, limit) {",
    "",
  ].join(String.fromCharCode(10));
  const badPatch = goodPatch.replace("-  return rounds > limit;", "-  return rounds > limit; // nope").replace("@@ -3,6 +3,6 @@", "@@ -99,6 +99,6 @@");

  let initialExit = null;
  try {
    execFileSync(TASK.verify.command, TASK.verify.args, { cwd: workdir, stdio: "ignore" });
    initialExit = 0;
  } catch (error) {
    initialExit = error?.status ?? 1;
  }

  const goodApplies = canApplyPatch(workdir, goodPatch);
  const badApplies = canApplyPatch(workdir, badPatch);
  let afterFixExit = null;
  if (goodApplies) {
    const file = path.join(tmpdir(), `absp-good-${Date.now().toString(36)}.diff`);
    writeFileSync(file, goodPatch);
    execFileSync("git", ["apply", file], { cwd: workdir, stdio: "ignore" });
    try {
      execFileSync(TASK.verify.command, TASK.verify.args, { cwd: workdir, stdio: "ignore" });
      afterFixExit = 0;
    } catch (error) {
      afterFixExit = error?.status ?? 1;
    }
  }

  // 散文（旧提示词的典型输出）必须被判"无补丁"
  const prose = extractPatch("我已经把 rounds > limit 改成 rounds >= limit，请合并。");
  const fenced = extractPatch("fence below" + String.fromCharCode(10) + "```diff" + String.fromCharCode(10) + goodPatch + String.fromCharCode(10) + "```");
  const fromJson = extractPatch(JSON.stringify({ status: "success", patch: goodPatch }));

  removeWorktree(workdir);

  const checks = [
    ["fixture 初始是红的（验收失败）", initialExit !== 0, `exit=${initialExit}`],
    ["正确补丁能 git apply", goodApplies, `applies=${goodApplies}`],
    ["apply 后验收变绿", afterFixExit === 0, `exit=${afterFixExit}`],
    ["错误补丁被拒（不会误判成可应用）", badApplies === false, `applies=${badApplies}`],
    ["散文描述被判无补丁", prose.patch === null, `source=${prose.source}`],
    ["```diff 围栏能被提取", fenced.patch !== null && fenced.source === "fenced", `source=${fenced.source}`],
    ["JSON.patch 字段能被提取", fromJson.patch !== null && fromJson.source === "json_field", `source=${fromJson.source}`],
  ];
  let failed = 0;
  for (const [name, ok, detail] of checks) {
    if (!ok) failed += 1;
    console.log(`  ${ok ? "PASS" : "FAIL"} ${name}（${detail}）`);
  }
  console.log(failed === 0 ? String.fromCharCode(10) + "自检通过：判据与补丁检测都可信。" : String.fromCharCode(10) + failed + " 项自检失败。");
  process.exit(failed === 0 ? 0 : 1);
}

function plan() {
  const runs = ARMS.length * RUNS_PER_ARM;
  const calls = runs * ASSUMED_CALLS_PER_RUN;
  console.log("子 Agent 提示词对照实验（未执行）");
  console.log(`  任务：${TASK.id} —— 修复 fixture/guards.mjs 的 off-by-one，验收 node --test 通过`);
  console.log(`  两臂：${ARMS.map((arm) => `PIFORGE_SUBAGENT_PROMPT=${arm}`).join("  vs  ")}`);
  console.log(`  跑次：${runs}（${ARMS.length} 臂 × ${RUNS_PER_ARM} 次），每次一个独立 git worktree`);
  console.log(`  隔离：独立 agent 目录 + PIFORGE_SESSION_DIR（不写共享 ~/.pi/agent/sessions）`);
  console.log(`  采集：输出 token / 总成本 / 成功率 / 补丁可 git apply（= 需人工补丁次数）`);
  console.log(`  预估：${calls} 次调用 ≈ $${(calls * BASELINE_COST_PER_CALL).toFixed(2)}（每题按 ${ASSUMED_CALLS_PER_RUN} 次调用估）`);
  console.log("  判据：contract 输出 token −30% 且 成功率不降 且 人工补丁 = 0");
  console.log("\n跑之前先确认：`npm run build:agent-host` 已执行（脚本走编译后的 host）。");
  return runs;
}

function report(dir) {
  if (!existsSync(dir)) {
    console.error(`没有结果（${dir}）。先跑 --run --spend。`);
    process.exit(2);
  }
  const files = readdirSync(dir).filter((name) => name.endsWith(".json"));
  const runs = files.map((name) => JSON.parse(readFileSync(path.join(dir, name), "utf8")));
  const median = (values) => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
  };
  const summarize = (arm) => {
    const rows = runs.filter((run) => run.arm === arm);
    return {
      arm,
      runs: rows.length,
      pass: rows.filter((run) => run.success).length,
      outputTokens: median(rows.map((run) => run.outputTokens ?? 0)),
      cost: Number(rows.reduce((sum, run) => sum + (run.cost ?? 0), 0).toFixed(4)),
      patchesNeedingHuman: rows.filter((run) => !run.patchApplies).length,
      turnsMedian: median(rows.map((run) => run.turns ?? 0)),
    };
  };
  const table = ARMS.map(summarize);
  console.log("子 Agent 提示词对照（每臂 " + RUNS_PER_ARM + " 次）");
  console.log("| 臂 | 成功率 | 输出 token 中位 | 成本 | 需人工补丁 | 轮数中位 |");
  console.log("|---|---|---|---|---|---|");
  for (const row of table) {
    console.log(
      `| ${row.arm} | ${row.pass}/${row.runs} | ${row.outputTokens.toLocaleString()} | $${row.cost} | ` +
        `${row.patchesNeedingHuman} | ${row.turnsMedian} |`,
    );
  }
  const legacy = table.find((row) => row.arm === "legacy");
  const contract = table.find((row) => row.arm === "contract");
  if (legacy && contract) {
    const drop = ((contract.outputTokens - legacy.outputTokens) / Math.max(1, legacy.outputTokens)) * 100;
    console.log("\n判据");
    console.log(`  ${drop <= -30 ? "PASS" : "FAIL"} 输出 token 下降 ≥30%：${legacy.outputTokens} → ${contract.outputTokens}（${drop.toFixed(1)}%）`);
    console.log(`  ${contract.pass >= legacy.pass ? "PASS" : "FAIL"} 成功率不降：${legacy.pass}/${legacy.runs} → ${contract.pass}/${contract.runs}`);
    console.log(`  ${contract.patchesNeedingHuman === 0 ? "PASS" : "FAIL"} 人工补丁次数 = 0：${contract.patchesNeedingHuman}`);
  }
}

async function run() {
  if (!has("--spend")) {
    console.log("拒绝执行：--run 会花真实 token。确认方案后加 --spend（也可以先 --plan 看预算）。");
    process.exit(2);
  }
  const { spawnSubagent } = await import(path.join(repoRoot, "agent-host", "dist", "agent-host", "subagents.js"));
  const agentDir = prepareIsolatedAgentDir();
  const sessionDir = path.join(tmpdir(), "piforge-absp-sessions");
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });

  for (const arm of ARMS) {
    for (let runIndex = 1; runIndex <= RUNS_PER_ARM; runIndex += 1) {
      const workdir = ensureFixtureWorktree(`${arm}-${runIndex}`);
      process.env.PIFORGE_SUBAGENT_PROMPT = arm;
      process.env.PIFORGE_SESSION_DIR = sessionDir;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      const startedAt = Date.now();
      const result = await spawnSubagent({
        name: `absp-${arm}-${runIndex}`,
        task: TASK.prompt,
        cwd: workdir,
        parentSessionId: `absp-parent-${arm}`,
      }).catch((error) => ({ ok: false, text: "", agent: null, error: String(error?.message ?? error) }));

      const finalText = typeof result.text === "string" ? result.text : "";
      const { patch, source } = extractPatch(finalText);
      const patchApplies = canApplyPatch(workdir, patch);
      let verifyExit = null;
      try {
        execFileSync(TASK.verify.command, TASK.verify.args, { cwd: workdir, stdio: "ignore" });
        verifyExit = 0;
      } catch (error) {
        verifyExit = error?.status ?? 1;
      }
      const record = {
        arm,
        run: runIndex,
        ok: result.ok === true,
        error: result.error ?? null,
        success: verifyExit === 0,
        patchSource: source,
        patchApplies,
        outputTokens: result?.agent?.usage?.output ?? 0,
        cost: result?.agent?.usage?.cost ?? 0,
        turns: result?.agent?.assistantTurns ?? 0,
        durationMs: Date.now() - startedAt,
        verifyExit,
      };
      writeFileSync(path.join(OUT_DIR, `${arm}__${runIndex}.json`), `${JSON.stringify(record, null, 2)}\n`);
      console.log(
        `  ${arm.padEnd(8)} #${runIndex} success=${record.success} patch=${source}/${patchApplies} ` +
          `out=${record.outputTokens} $${record.cost.toFixed(4)} turns=${record.turns}`,
      );
      removeWorktree(workdir);
    }
  }
  console.log(`\n结果目录：${path.relative(repoRoot, OUT_DIR)}；用 --report 看汇总。`);
}

if (has("--selfcheck")) selfcheck();
else if (has("--report")) report(OUT_DIR);
else if (has("--run")) await run();
else plan();
