#!/usr/bin/env node
/**
 * 上下文治理 A/B 的**执行器**（本轮只交付、不跑正式实验）。
 *
 * 判分集：scripts/ab-context-tasks.json（20 题，四类各 5 题，其中 8 题需要长上下文）。
 * 设计说明：docs/optimizations/context-governance-ab.md。
 *
 * 四组（每组独立开关，可组合）：
 *   control     —— 现状
 *   L-D         —— `PIFORGE_TOOL_OUTPUT_CHARS=2000`（工具输出落盘/截断 4000 → 2000）
 *   L-B         —— `PIFORGE_SESSION_SPLIT_HINT=1`（会话拆分提示）
 *   L-D+L-B     —— 两个都开
 *
 * 模式（默认只做不花钱的前三个）：
 *   --validate           校验判分集本身（字段、路径、正则可编译、expectInitial 与现状一致）
 *   --selfcheck          在临时工作树里跑一遍 check（不调模型），确认"这些判据真的会红/会绿"
 *   --plan               打印 4 组 × 20 题的方案、样本量与预估成本
 *   --run --spend        ★ 真跑（会花 token，必须显式加 --spend；本轮不执行）
 *   --report <dir>       汇总已跑完的结果（每个 run 一个 JSON）
 *
 * 为什么默认不跑：一次 20 题 × 4 组 = 80 次真实任务，按本机 cacheRead 中位
 * 146k tok/调用估，约 $8–12。跑之前必须先有人审过判分集与开关实现。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** 真正的执行内核（起 host、发 prompt、读会话 JSONL、判 check）。 */
const { ARMS, runTask } = await import("./ab-run-task.mjs");
const tasksFile = path.join(repoRoot, "scripts", "ab-context-tasks.json");
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const argOf = (flag, fallback) => {
  const index = argv.indexOf(flag);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

/** 四组开关：键即组名，值为注入 host 的环境变量。 */
export const GROUPS = {
  control: {},
  "L-D": { PIFORGE_TOOL_OUTPUT_CHARS: "2000" },
  "L-B": { PIFORGE_SESSION_SPLIT_HINT: "1" },
  "L-D+L-B": { PIFORGE_TOOL_OUTPUT_CHARS: "2000", PIFORGE_SESSION_SPLIT_HINT: "1" },
};
/** 对照组基线（用于文档里的成本估算）：cacheRead 中位 146 176 tok/调用。 */
/** 本机 60 会话的请求级 cacheRead 中位（audit:token 实测）。 */
const BASELINE_CACHE_READ_MEDIAN = 146_176;
/** 实测均值成本/调用（audit:token：$22.36 / 10 227 次调用）。 */
const BASELINE_COST_PER_CALL = 0.0022;
/** 一个 agentic 任务平均要发多少次模型请求（含工具循环；按本机 session 统计取 15）。 */
const ASSUMED_CALLS_PER_TASK = 15;

function loadTasks() {
  const parsed = JSON.parse(readFileSync(tasksFile, "utf8"));
  if (!Array.isArray(parsed.tasks)) throw new Error("ab tasks: 缺少 tasks 数组");
  return parsed.tasks;
}

const CHECK_TYPES = new Set(["file-contains", "file-matches", "file-absent", "json-field", "json-fields", "json-field-at-least"]);

function validate(tasks) {
  const problems = [];
  const ids = new Set();
  for (const [index, task] of tasks.entries()) {
    const where = `tasks[${index}]${task?.id ? ` (${task.id})` : ""}`;
    for (const key of ["id", "category", "prompt", "check"]) {
      if (!task?.[key]) problems.push(`${where}: 缺少 ${key}`);
    }
    if (task?.id && ids.has(task.id)) problems.push(`${where}: id 重复`);
    if (task?.id) ids.add(task.id);
    if (typeof task?.turns !== "number" || task.turns < 1) problems.push(`${where}: turns 必须是 ≥1 的数字`);
    if (!["code-edit", "doc-lookup", "test-fix", "script-write"].includes(task?.category)) {
      problems.push(`${where}: category 不在四类里`);
    }
    const check = task?.check;
    if (!check) continue;
    if (!CHECK_TYPES.has(check.type)) problems.push(`${where}: 未知 check.type=${check.type}`);
    if (check.type === "file-matches") {
      try {
        new RegExp(check.regex);
      } catch {
        problems.push(`${where}: regex 无法编译`);
      }
    }
    if (["json-field", "json-fields", "json-field-at-least"].includes(check.type) && !check.path) {
      problems.push(`${where}: json check 需要 path`);
    }
  }
  const longContext = tasks.filter((task) => task.longContext).length;
  if (longContext < 5) problems.push(`长上下文题目只有 ${longContext} 个（要求 ≥5，用于测 L-A 风险）`);
  return { problems, longContext };
}

/** 在给定工作树里评估一个 check（纯文件读取，不调模型）。 */
function evaluateCheck(check, workdir) {
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

/** 造一个干净工作树：git worktree add + 软链 node_modules（不复制 200MB）。 */
function createWorktree(label) {
  const dir = path.join(tmpdir(), `piforge-ab-${label}-${Date.now().toString(36)}`);
  execFileSync("git", ["worktree", "add", "--detach", dir, "HEAD"], { cwd: repoRoot, stdio: "ignore" });
  const modules = path.join(repoRoot, "node_modules");
  const link = path.join(dir, "node_modules");
  if (existsSync(modules) && !existsSync(link)) {
    try {
      if (process.platform === "win32") {
        execFileSync("cmd", ["/c", "mklink", "/J", link, modules], { stdio: "ignore" });
      } else {
        execFileSync("ln", ["-s", modules, link], { stdio: "ignore" });
      }
    } catch {
      // 拿不到 node_modules 也不致命（本题只读文件）
    }
  }
  return dir;
}

function removeWorktree(dir) {
  try {
    execFileSync("git", ["worktree", "remove", "--force", dir], { cwd: repoRoot, stdio: "ignore" });
  } catch {
    rmSync(dir, { recursive: true, force: true });
  }
}

function selfcheck(tasks) {
  const dir = createWorktree("selfcheck");
  const rows = [];
  try {
    for (const task of tasks) {
      const pass = evaluateCheck(task.check, dir);
      const expected = task.expectInitial === "pass";
      rows.push({
        id: task.id,
        longContext: Boolean(task.longContext),
        initialState: pass ? "pass" : "fail",
        expectedInitial: task.expectInitial ?? "fail",
        consistent: pass === expected,
      });
    }
  } finally {
    removeWorktree(dir);
  }
  return rows;
}

function plan(tasks) {
  const groupNames = Object.keys(GROUPS);
  const runs = groupNames.length * tasks.length;
  // 一次任务 ≠ 一次调用：agentic 任务会反复工具循环，按 ASSUMED_CALLS_PER_TASK 估（脚本里显式写出假设）。
  const calls = groupNames.length * tasks.length * ASSUMED_CALLS_PER_TASK;
  const estimate = (calls * BASELINE_COST_PER_CALL).toFixed(2);
  const twoRoundCalls = calls * 2;
  return {
    groups: groupNames,
    tasks: tasks.length,
    runs,
    modelCalls: calls,
    assumedCallsPerTask: ASSUMED_CALLS_PER_TASK,
    baselineCostPerCall: BASELINE_COST_PER_CALL,
    estimatedCostUsd: Number(estimate),
    twoRound: {
      runs: runs * 2,
      modelCalls: twoRoundCalls,
      costUsd: Number((twoRoundCalls * BASELINE_COST_PER_CALL).toFixed(2)),
      // 与单轮口径一致：每题 3 分钟、2 组并行 → 两轮 = 2 × (runs × 3 / 2) 分钟
      hours: Number(((runs * 2 * 3) / 2 / 60).toFixed(1)),
    },
    longContextTasks: tasks.filter((task) => task.longContext).map((task) => task.id),
    perTaskMinutes: { p50: 2, p90: 6 },
    wallClockMinutes: Math.round((runs * 3) / 2),
  };
}

function report(dir) {
  const files = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json")) : [];
  const runs = files.map((name) => JSON.parse(readFileSync(path.join(dir, name), "utf8")));
  const byArm = new Map();
  for (const run of runs) {
    const bucket = byArm.get(run.arm) ?? { arm: run.arm, runs: [] };
    bucket.runs.push(run);
    byArm.set(run.arm, bucket);
  }
  const median = (values) => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
  };
  return [...byArm.values()].map((bucket) => {
    const rows = bucket.runs;
    const passed = rows.filter((run) => run.passed).length;
    return {
      arm: bucket.arm,
      runs: rows.length,
      pass: passed,
      passRate: Number(((passed / Math.max(1, rows.length)) * 100).toFixed(1)),
      cacheReadMedianPerCall: median(rows.map((run) => run.cacheReadMedianPerCall ?? 0)),
      inputMissRatioMedian: Number(
        (median(rows.map((run) => Math.round((run.inputMissRatio ?? 0) * 10_000))) / 10_000).toFixed(4),
      ),
      callsMedian: median(rows.map((run) => run.calls ?? 0)),
      costTotal: Number(rows.reduce((sum, run) => sum + (run.cost ?? 0), 0).toFixed(4)),
      durationMedianMs: median(rows.map((run) => run.durationMs ?? 0)),
      timeouts: rows.filter((run) => run.timedOut).length,
      errors: rows.filter((run) => run.error).length,
    };
  });
}

/** 五条判据（docs/optimizations/context-governance-ab.md 第 6 节）。 */
export function judgeArms(table) {
  const control = table.find((row) => row.arm === "control");
  const treatment = table.find((row) => row.arm && row.arm !== "control");
  if (!control || !treatment) return null;
  const pct = (next, base) => (base === 0 ? 0 : ((next - base) / base) * 100);
  const controlErrors = control.runs - control.pass;
  const treatmentErrors = treatment.runs - treatment.pass;
  const checks = [
    {
      name: "cacheRead 中位 -15%（L-D 合格线）",
      detail: `${control.cacheReadMedianPerCall} -> ${treatment.cacheReadMedianPerCall}`,
      value: pct(treatment.cacheReadMedianPerCall, control.cacheReadMedianPerCall),
      pass: treatment.cacheReadMedianPerCall <= control.cacheReadMedianPerCall * 0.85,
      unit: "pct",
    },
    {
      name: "错的题数不增加",
      detail: `${controlErrors} 错 -> ${treatmentErrors} 错`,
      value: treatmentErrors - controlErrors,
      pass: treatmentErrors <= controlErrors,
      unit: "count",
    },
    {
      name: "总成本 -10%",
      detail: `$${control.costTotal} -> $${treatment.costTotal}`,
      value: pct(treatment.costTotal, control.costTotal),
      pass: treatment.costTotal <= control.costTotal * 0.9,
      unit: "pct",
    },
    {
      name: "耗时 <= +10%",
      detail: `${(control.durationMedianMs / 1000).toFixed(0)}s -> ${(treatment.durationMedianMs / 1000).toFixed(0)}s`,
      value: pct(treatment.durationMedianMs, control.durationMedianMs),
      pass: treatment.durationMedianMs <= control.durationMedianMs * 1.1,
      unit: "pct",
    },
    {
      name: "调用数/题 <= +10%",
      detail: `${control.callsMedian} -> ${treatment.callsMedian}`,
      value: pct(treatment.callsMedian, control.callsMedian),
      pass: treatment.callsMedian <= control.callsMedian * 1.1,
      unit: "pct",
    },
  ];
  return { control: control.arm, treatment: treatment.arm, checks, passed: checks.every((check) => check.pass) };
}

async function main() {
  const tasks = loadTasks();
  const { problems, longContext } = validate(tasks);

  if (has("--validate") || (!has("--selfcheck") && !has("--plan") && !has("--run") && !has("--report"))) {
    console.log(`判分集：${tasks.length} 题（长上下文 ${longContext} 题）→ ${path.relative(repoRoot, tasksFile)}`);
    if (problems.length > 0) {
      console.log("校验失败：");
      for (const problem of problems) console.log(`  - ${problem}`);
      process.exit(1);
    }
    const byCategory = tasks.reduce((acc, task) => {
      acc[task.category] = (acc[task.category] ?? 0) + 1;
      return acc;
    }, {});
    console.log(`分类：${JSON.stringify(byCategory)}`);
    console.log("校验通过。");
    if (!has("--selfcheck") && !has("--plan") && !has("--run") && !has("--report")) return;
  }

  if (has("--selfcheck")) {
    const rows = selfcheck(tasks);
    console.log("自检（临时工作树，不调模型）：判据是否与 expectInitial 一致");
    for (const row of rows) {
      console.log(
        `  ${row.consistent ? "✓" : "✗"} ${row.id.padEnd(26)} 现状=${row.initialState} 期望=${row.expectedInitial}${row.longContext ? " [长上下文]" : ""}`,
      );
    }
    const bad = rows.filter((row) => !row.consistent).length;
    console.log(bad === 0 ? "\n全部一致：判据可用。" : `\n${bad} 题判据与期望不符，需修正。`);
    process.exit(bad === 0 ? 0 : 1);
  }

  if (has("--plan")) {
    const result = plan(tasks);
    console.log("A/B 方案（不执行）");
    console.log(`  组：${result.groups.join(" / ")}`);
    console.log(`  题：${result.tasks}（长上下文 ${result.longContextTasks.length}）`);
    console.log(`  跑次：${result.runs}（${result.groups.length} 组 × ${result.tasks} 题），模型调用 ≈ ${result.modelCalls}`);
    console.log(
      `  预估成本：$${result.estimatedCostUsd}（假设每题 ${result.assumedCallsPerTask} 次调用 × 实测均值 $${result.baselineCostPerCall}/调用）`,
    );
    console.log(`  预估墙钟：≈ ${result.wallClockMinutes} 分钟（单题 2–6 分钟，可并行 2 组）`);
    console.log(
      `  两轮预算（正式结论的最低要求）：${result.twoRound.runs} 次任务 / ${result.twoRound.modelCalls.toLocaleString()} 次调用 / ≈$${result.twoRound.costUsd} / ≈${result.twoRound.hours} 小时`,
    );
    console.log(
      `  control 臂预估 cacheRead 中位：${BASELINE_CACHE_READ_MEDIAN.toLocaleString()} tok/调用` +
        `（本机 60 会话实测；偏离超过 ±30% 要先复核目标再跑）`,
    );
    console.log(`  长上下文题：${result.longContextTasks.join(", ")}`);
    return;
  }

  if (has("--report")) {
    const dir = argOf("--report", "tmp/ab-runs");
    const rows = report(dir);
    if (rows.length === 0) {
      console.log(`没有找到结果（${dir}/*.json）。先跑 --run --spend。`);
      return;
    }
    console.log("A/B 汇总（每次 run 一个 JSON）");
    console.log("| 臂 | 题次 | 成功率 | cacheRead 中位/调用 | 未命中 input 占比 | 调用数中位 | 成本 | 耗时中位 | 超时/错误 |");
    console.log("|---|---|---|---|---|---|---|---|---|");
    for (const row of rows) {
      console.log(
        `| ${row.arm} | ${row.runs} | ${row.passRate}% | ${row.cacheReadMedianPerCall.toLocaleString()} | ` +
          `${(row.inputMissRatioMedian * 100).toFixed(1)}% | ${row.callsMedian} | $${row.costTotal} | ` +
          `${(row.durationMedianMs / 1000).toFixed(0)}s | ${row.timeouts}/${row.errors} |`,
      );
    }
    const verdict = judgeArms(rows);
    if (verdict) {
      console.log(`\n判据（${verdict.control} vs ${verdict.treatment}）：`);
      for (const check of verdict.checks) {
        const value =
          check.unit === "count"
            ? `${check.value > 0 ? "+" : ""}${check.value}`
            : `${check.value >= 0 ? "+" : ""}${check.value.toFixed(1)}%`;
        console.log(`  ${check.pass ? "PASS" : "FAIL"} ${check.name}：${check.detail}（${value}）`);
      }
      console.log(`\n结论：${verdict.passed ? "五条判据全部满足 → L-D 有效" : "未全部满足 → 见上面哪条没过"}`);
    }
    return;
  }

  if (has("--run")) {
    if (!has("--spend")) {
      console.log("拒绝执行：--run 会花真实 token。确认判分集与开关后加 --spend。");
      process.exit(2);
    }
    const arms = argOf("--arms", "control,L-D").split(",").map((entry) => entry.trim()).filter(Boolean);
    for (const arm of arms) {
      if (!(arm in ARMS)) {
        console.error(`未知实验臂: ${arm}（可用：${Object.keys(ARMS).join(", ")}）`);
        process.exit(2);
      }
    }
    const rounds = Number(argOf("--rounds", "1"));
    const only = argOf("--tasks", "");
    const selected = only ? tasks.filter((task) => only.split(",").includes(task.id)) : tasks;
    const outDir = path.join(repoRoot, "tmp", "ab-runs");
    const timeoutMs = Number(argOf("--timeout-min", "8")) * 60_000;

    console.log(`A/B 执行：${rounds} 轮 x ${arms.length} 臂 x ${selected.length} 题 = ${rounds * arms.length * selected.length} 次`);
    console.log(
      `臂：${arms.map((arm) => `${arm}${Object.keys(ARMS[arm]).length ? `(${JSON.stringify(ARMS[arm])})` : "(基线)"}`).join(" . ")}`,
    );
    console.log(`结果目录：${path.relative(repoRoot, outDir)}，单题超时 ${timeoutMs / 60000} 分钟\n`);

    const startedAt = Date.now();
    let done = 0;
    const total = rounds * arms.length * selected.length;
    for (let round = 1; round <= rounds; round += 1) {
      for (const arm of arms) {
        for (const task of selected) {
          done += 1;
          const result = await runTask({ task, arm, round, timeoutMs, outDir });
          const flags = [
            result.passed ? "PASS" : "fail",
            result.timedOut ? "TIMEOUT" : null,
            result.error ? `err=${String(result.error).slice(0, 60)}` : null,
          ]
            .filter(Boolean)
            .join(" ");
          console.log(
            `  [${done}/${total}] r${round} ${arm.padEnd(8)} ${task.id.padEnd(26)} ${flags.padEnd(12)} ` +
              `calls=${result.calls ?? 0} cacheReadMed=${result.cacheReadMedianPerCall ?? 0} ` +
              `miss=${((result.inputMissRatio ?? 0) * 100).toFixed(1)}% $${(result.cost ?? 0).toFixed(4)} ` +
              `${((result.durationMs ?? 0) / 1000).toFixed(0)}s`,
          );
        }
      }
    }
    console.log(`\n完成 ${total} 次，用时 ${((Date.now() - startedAt) / 60000).toFixed(0)} 分钟。`);
    console.log(`用 --report ${path.relative(repoRoot, outDir)} 看汇总与判据。`);
    process.exit(0);
  }
}

await main();
