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
  const byGroup = new Map();
  for (const run of runs) {
    const bucket = byGroup.get(run.group) ?? { group: run.group, runs: [], pass: 0 };
    bucket.runs.push(run);
    if (run.passed) bucket.pass += 1;
    byGroup.set(run.group, bucket);
  }
  const median = (values) => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
  };
  return [...byGroup.values()].map((bucket) => ({
    group: bucket.group,
    tasks: bucket.runs.length,
    passRate: Number(((bucket.pass / Math.max(1, bucket.runs.length)) * 100).toFixed(1)),
    cacheReadMedianPerCall: median(bucket.runs.flatMap((run) => run.cacheReadPerCall ?? [])),
    costTotal: Number(bucket.runs.reduce((sum, run) => sum + (run.cost ?? 0), 0).toFixed(4)),
    durationMedianMs: median(bucket.runs.map((run) => run.durationMs ?? 0)),
  }));
}

function main() {
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
    console.log("A/B 汇总");
    console.log("| 组 | 题数 | 成功率 | cacheRead 中位/调用 | 成本 | 耗时中位 |");
    console.log("|---|---|---|---|---|---|");
    for (const row of rows) {
      console.log(
        `| ${row.group} | ${row.tasks} | ${row.passRate}% | ${row.cacheReadMedianPerCall.toLocaleString()} | $${row.costTotal} | ${(row.durationMedianMs / 1000).toFixed(1)}s |`,
      );
    }
    return;
  }

  if (has("--run")) {
    if (!has("--spend")) {
      console.log("拒绝执行：--run 会花真实 token。确认判分集与开关后加 --spend。");
      process.exit(2);
    }
    console.log("--run 的执行路径见 docs/optimizations/context-governance-ab.md §5（本轮交付不执行）。");
    process.exit(2);
  }
}

main();
