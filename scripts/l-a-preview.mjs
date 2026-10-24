#!/usr/bin/env node
/**
 * L-A 预演：压缩触发点前移，模型还能不能答对？
 *
 * 背景（token 线）：
 *   - L-D（工具输出 4000→2000）已被 80 次 A/B 证伪（cacheRead −0.4%）；
 *   - L-B 是用户行为实验，需真实数据；
 *   - 唯一还没验的杠杆是 **L-A：把压缩触发点前移**，让每轮的 cacheRead 变小。
 *
 * 风险很明确：压缩会**丢掉细节**。如果模型因此答不对长上下文题，L-A 就不能上。
 * 所以先做预演（24 次调用），只判断方向；正式结论仍需 A/B。
 *
 * 三种状态（阈值取自 `agent-host/compaction-plan.ts` 的真实常量）：
 *
 *   | 状态 | 触发点 | 硬顶 | 预算比 | 说明 |
 *   |---|---|---|---|---|
 *   | C1 | 现状 | 48 000 | 0.45 | 对照组 |
 *   | C2 | 前移 30% | 33 600 | 0.315 | 目标状态（cacheRead 目标 ≈100k） |
 *   | C3 | 前移 50% | 24 000 | 0.225 | 激进档，用于看成功率拐点 |
 *
 * 注意：这是**状态级**预演 —— 把 26 MB 真实会话按"压缩后在各自硬顶之下"的规模重建
 * （保留最近若干整轮 + 四段式摘要），然后在同一批长上下文题上跑。
 * 它检验的是"上下文少了一半，题还做得对吗"，不是"压缩算法本身好不好"。
 *
 * 用法：
 *   node scripts/l-a-preview.mjs --build                 # 构造三种状态 + 归档素材
 *   node scripts/l-a-preview.mjs --run                   # 8 题 × 3 状态（真花 token，约 $0.1）
 *   node scripts/l-a-preview.mjs --report                # 汇总 + 判据
 *   node scripts/l-a-preview.mjs --run --tasks E2-heap-env-override-doc   # 只跑一题排障
 *
 * 素材写到 `docs/optimizations/l-a-preview/`（**不写** ~/.pi/agent/sessions，
 * 避免污染 audit:token 的统计口径）；运行时会话写到临时 agent 目录。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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

const MATERIAL_DIR = path.join(repoRoot, "docs", "optimizations", "l-a-preview");
const RUNS_DIR = path.join(repoRoot, "tmp", "l-a-preview", "runs");
const AGENT_DIR = path.join(tmpdir(), "piforge-la-preview-agent");
const STATE_DIR = path.join(tmpdir(), "piforge-la-preview-states");
const SOURCE_SESSION = process.env.PIFORGE_LA_SOURCE ?? null;

/** 判分集里挑选的 8 道长上下文题（`longContext: true`）。 */
const LONG_CONTEXT_TASKS = [
  "E2-heap-env-override-doc",
  "E3-composer-aria",
  "E4-rpc-guard-comment",
  "E5-server-shutdown-log",
  "T3-tsc-error-report",
  "S1-count-listen-calls",
  "S2-loc-report",
  "S5-large-file-digest",
];

/**
 * 三档状态。`retainedTokens` 是"压缩后保留下来的上下文规模"（不含 6.6k 前缀），
 * 取各自硬顶的 ~62%，保证一次任务（约 +10–20k）不会把状态顶过硬顶、触发二次压缩
 * —— 否则三档会在第一次调用后就收敛成同一种状态，实验就没有区分度了。
 */
export const STATES = {
  C1: {
    label: "C1 现状（硬顶 48k）",
    ceiling: 48_000,
    budgetRatio: 0.45,
    retainedTokens: 30_000,
    note: "对照组：pi/PiForge 当前默认",
  },
  C2: {
    label: "C2 前移 30%（硬顶 33.6k，目标）",
    ceiling: 33_600,
    budgetRatio: 0.315,
    retainedTokens: 20_000,
    note: "目标状态：cacheRead 目标 ≈100k",
  },
  C3: {
    label: "C3 前移 50%（硬顶 24k，激进）",
    ceiling: 24_000,
    budgetRatio: 0.225,
    retainedTokens: 12_000,
    note: "激进档：用于观察成功率拐点",
  },
};

// ---------------------------------------------------------------------------
// token 估算（与 lib/token-guard.ts 同口径：CJK ≈ 1 字/token，其它 ≈ 4 字符/token）
// ---------------------------------------------------------------------------
export function estimateTextTokens(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (/[\u3000-\u9fff\uff00-\uffef]/.test(char)) cjk += 1;
    else other += 1;
  }
  return Math.round(cjk + other / 4);
}

function entryText(entry) {
  const message = entry.message ?? {};
  const content = message.content;
  const parts = [];
  if (typeof content === "string") parts.push(content);
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (typeof block.text === "string") parts.push(block.text);
      if (typeof block.content === "string") parts.push(block.content);
      if (Array.isArray(block.content)) {
        for (const inner of block.content) {
          if (inner && typeof inner.text === "string") parts.push(inner.text);
        }
      }
      if (block.type === "toolCall" && block.arguments) parts.push(JSON.stringify(block.arguments));
    }
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// 素材构造
// ---------------------------------------------------------------------------
function pickSourceSession() {
  if (SOURCE_SESSION && existsSync(SOURCE_SESSION)) return SOURCE_SESSION;
  const root = path.join(homedir(), ".pi", "agent", "sessions");
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".jsonl")) files.push({ full, size: statSync(full).size });
    }
  };
  walk(root);
  files.sort((left, right) => right.size - left.size);
  return files[0]?.full ?? null;
}

function readSession(file) {
  const entries = [];
  let header = null;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "session") header = entry;
    else entries.push(entry);
  }
  return { header, entries };
}

/**
 * 从被压缩掉的消息里抽一份**确定性**四段式摘要。
 *
 * 真实的 pi 压缩是模型摘要；这里用确定性抽取（更保守：信息只少不多）。
 * 如果模型在"这种更差的摘要"下仍能答对，真实压缩（摘要更好）应当也能。
 */
export function buildSummary(droppedEntries) {
  const intents = [];
  const files = new Set();
  const errors = [];
  const decisions = [];
  for (const entry of droppedEntries) {
    const message = entry.message ?? {};
    const text = entryText(entry);
    if (message.role === "user") {
      const first = text.split("\n").find((line) => line.trim().length > 0) ?? "";
      if (first.trim()) intents.push(first.trim().slice(0, 160));
    }
    for (const match of text.matchAll(/[A-Za-z0-9_./\\-]+\.(?:ts|tsx|js|mjs|json|md|css)/g)) {
      if (files.size < 60) files.add(match[0]);
    }
    if (message.role === "toolResult" && (message.isError === true || /\b(error|failed|EACCES|ENOENT)\b/i.test(text.slice(0, 400)))) {
      const firstLine = text.split("\n").find((line) => line.trim().length > 0) ?? "";
      if (firstLine.trim() && errors.length < 12) errors.push(firstLine.trim().slice(0, 160));
    }
    if (message.role === "assistant" && /(决定|decision|结论|采纳|放弃|不立项|verdict)/i.test(text)) {
      const line = text.split("\n").find((candidate) => /(决定|结论|采纳|放弃)/.test(candidate)) ?? "";
      if (line.trim() && decisions.length < 10) decisions.push(line.trim().slice(0, 200));
    }
  }
  const section = (title, items) => `## ${title}\n${items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- （无）"}`;
  return [
    "## 用户意图（被压缩区间）",
    intents.length > 0 ? intents.slice(0, 12).map((item) => `- ${item}`).join("\n") : "- （无）",
    "",
    "## 涉及文件",
    files.size > 0 ? [...files].map((item) => `- ${item}`).join("\n") : "- （无）",
    "",
    section("关键报错", errors),
    "",
    section("最终决策", decisions),
  ].join("\n");
}

/** 从后往前按整轮（user 消息为界）累加，直到达到 retainedTokens。 */
function selectRetainedRounds(entries, retainedTokens) {
  // 找每个 user 消息的下标作为轮次边界
  const boundaries = [];
  entries.forEach((entry, index) => {
    if (entry?.message?.role === "user") boundaries.push(index);
  });
  if (boundaries.length === 0) return { from: 0, keptTokens: 0 };

  let keptTokens = 0;
  let cutIndex = entries.length;
  for (let round = boundaries.length - 1; round >= 0; round -= 1) {
    const start = boundaries[round];
    if (keptTokens >= retainedTokens) {
      cutIndex = boundaries[round + 1] ?? entries.length;
      break;
    }
    const end = round + 1 < boundaries.length ? boundaries[round + 1] : entries.length;
    let roundTokens = 0;
    for (let index = start; index < end; index += 1) roundTokens += estimateTextTokens(entryText(entries[index]));
    keptTokens += roundTokens;
    cutIndex = start;
  }
  return { from: cutIndex, keptTokens, boundaries };
}

/**
 * 目标小于"单个轮次"时的压力裁剪：只保留最后一轮，并把其中超长的工具输出
 * 按**现有**的输出预算（4 000 字符，`agent-host/tool-output-budget.ts` 的默认档）截断。
 *
 * 为什么不按消息随手切：pi 装载会话时 toolCall / toolResult 必须成对，
 * 中间丢一条会让 `agent.ensure` 之后的 prompt 完全不起作用（实测 C3 一次调用都没有）。
 * 所以这里只做两件结构安全的事：裁轮次 + 裁超长输出。
 */
function stressTrimRound(entries, from, targetTokens = 12_000, maxToolResultChars = 4_000) {
  /**
   * 结构安全地往下裁：
   *   1. 先把"一轮"拆成**成对单元**（一个 assistant 消息 + 它触发的 toolResult），
   *      这样不会出现"有 result 没 call"或"有 call 等不到 result"的残局；
   *   2. 从尾部往前保留单元，直到达到目标；
   *   3. 仍超长时，才把超长工具输出按现有 4 000 字符预算截断。
   */
  const round = entries.slice(from);
  const units = [];
  let current = null;
  for (const entry of round) {
    const message = entry?.message ?? {};
    const isAssistantWithCalls =
      message.role === "assistant" &&
      Array.isArray(message.content) &&
      message.content.some((block) => block?.type === "toolCall");
    if (isAssistantWithCalls || current === null) {
      if (current) units.push(current);
      current = [entry];
    } else {
      current.push(entry);
    }
  }
  if (current) units.push(current);

  const sizeOf = (unit) => unit.reduce((sum, entry) => sum + estimateTextTokens(entryText(entry)), 0);
  const keptUnits = [];
  let total = 0;
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const size = sizeOf(units[index]);
    if (index < units.length - 1 && total + size > targetTokens) break;
    keptUnits.unshift(units[index]);
    total += size;
  }
  const keptEntries = keptUnits.flat();
  if (total <= targetTokens) return keptEntries;
  // 还是太大：截断超长工具输出（与运行时预算一致）
  return keptEntries.map((entry) => {
    const message = entry?.message;
    if (!message || message.role !== "toolResult" || !Array.isArray(message.content)) return entry;
    let touched = false;
    const content = message.content.map((block) => {
      if (block && typeof block === "object" && typeof block.text === "string" && block.text.length > maxToolResultChars) {
        touched = true;
        return { ...block, text: `${block.text.slice(0, maxToolResultChars)}
… 【预演：本条输出被截断，原长 ${block.text.length} 字符】` };
      }
      return block;
    });
    return touched ? { ...entry, message: { ...message, content } } : entry;
  });
}

function buildState(entries, header, stateKey) {
  const state = STATES[stateKey];
  const selected = selectRetainedRounds(entries, state.retainedTokens);
  const from = selected.from;
  let kept = entries.slice(from);
  let keptTokens = kept.reduce((sum, entry) => sum + estimateTextTokens(entryText(entry)), 0);
  let stressed = false;
  if (keptTokens > state.retainedTokens * 1.15) {
    // 单轮就超过目标：只保留最后一轮 + 按现有输出预算截断超长工具输出（结构安全）
    kept = stressTrimRound(entries, from, state.retainedTokens);
    keptTokens = kept.reduce((sum, entry) => sum + estimateTextTokens(entryText(entry)), 0);
    stressed = true;
  }
  const dropped = entries.slice(0, from);
  const summary = buildSummary(dropped);
  const summaryTokens = estimateTextTokens(summary);
  /** 压缩后下一轮请求的上下文估算 ≈ 前缀 + 摘要 + 保留原文。 */
  const estimatedContextTokens = 6_640 + summaryTokens + keptTokens;

  const id = `01a${Date.now().toString(16).padStart(9, "0")}${Math.floor(Math.random() * 1e6).toString(16)}`.slice(0, 26);
  const compactionEntry = {
    type: "compaction",
    id: `preview${stateKey}`,
    parentId: null,
    timestamp: new Date().toISOString(),
    summary,
    previewState: stateKey,
    previewLabel: state.label,
  };
  const keptIds = new Set(kept.map((entry) => entry.id).filter(Boolean));
  const lines = [
    JSON.stringify({ ...header, id, timestamp: new Date().toISOString(), previewState: stateKey }),
    JSON.stringify(compactionEntry),
    ...kept.map((entry) => JSON.stringify(entry)),
  ];
  return {
    stateKey,
    label: state.label,
    stressed,
    file: null,
    summary,
    summaryTokens,
    keptTokens,
    keptEntries: kept.length,
    droppedEntries: dropped.length,
    keptIds: keptIds.size,
    estimatedContextTokens,
    estimatedCacheRead: estimatedContextTokens,
    ceiling: state.ceiling,
    budgetRatio: state.budgetRatio,
    lines,
  };
}

function build() {
  const source = pickSourceSession();
  if (!source) {
    console.error("l-a-preview: 找不到源会话（可用 PIFORGE_LA_SOURCE 指定）");
    process.exit(2);
  }
  const { header, entries } = readSession(source);
  mkdirSync(MATERIAL_DIR, { recursive: true });
  mkdirSync(STATE_DIR, { recursive: true });

  const material = {
    generatedAt: new Date().toISOString(),
    sourceSession: path.basename(source),
    sourceSizeMb: Number((statSync(source).size / 1048576).toFixed(1)),
    sourceEntries: entries.length,
    method:
      "按整轮（user 消息为界）从尾部保留，直到达到各状态的目标保留 token；" +
      "被丢弃区间用**确定性四段式摘要**替代（比真实模型摘要更保守）。",
    states: [],
  };

  for (const stateKey of Object.keys(STATES)) {
    const built = buildState(entries, header, stateKey);
    const file = path.join(STATE_DIR, `${stateKey}.jsonl`);
    writeFileSync(file, `${built.lines.join("\n")}\n`);
    built.file = file;
    delete built.lines;
    writeFileSync(path.join(MATERIAL_DIR, `${stateKey}-summary.md`), `# ${built.label}\n\n${built.summary}\n`);
    material.states.push({
      stateKey: built.stateKey,
      label: built.label,
      ceiling: built.ceiling,
      budgetRatio: built.budgetRatio,
      keptEntries: built.keptEntries,
      droppedEntries: built.droppedEntries,
      stressed: built.stressed,
      keptTokens: built.keptTokens,
      summaryTokens: built.summaryTokens,
      estimatedContextTokens: built.estimatedContextTokens,
      stateFile: path.relative(repoRoot, file),
      sizeKb: Number((statSync(file).size / 1024).toFixed(1)),
    });
    console.log(
      `  ${stateKey}: 保留 ${built.keptEntries} 条（≈${built.keptTokens} tok）+ 摘要 ${built.summaryTokens} tok ` +
        `→ 估算上下文 ${built.estimatedContextTokens} tok（硬顶 ${built.ceiling}）${built.stressed ? " [压力裁剪：单轮超目标，裁到轮内]" : ""}`,
    );
  }

  writeFileSync(path.join(MATERIAL_DIR, "states.json"), `${JSON.stringify(material, null, 2)}\n`);
  console.log(`\n素材已归档：${path.relative(repoRoot, MATERIAL_DIR)}（摘要 3 份 + states.json）`);
  console.log(`状态会话文件（临时，不写 ~/.pi/agent/sessions）：${STATE_DIR}`);
}

// ---------------------------------------------------------------------------
// 运行
// ---------------------------------------------------------------------------
function prepareAgentDir() {
  // 独立 agent 目录：复用真实 auth/models/settings，但会话落到临时目录（不污染审计口径）
  mkdirSync(AGENT_DIR, { recursive: true });
  const home = path.join(homedir(), ".pi", "agent");
  for (const name of ["auth.json", "models.json", "models-store.json", "settings.json", "trust.json"]) {
    const from = path.join(home, name);
    const to = path.join(AGENT_DIR, name);
    if (existsSync(from) && !existsSync(to)) {
      writeFileSync(to, readFileSync(from));
    }
  }
  return AGENT_DIR;
}

async function run() {
  const { runTask, loadTasks } = await import("./ab-run-task.mjs");
  const tasks = loadTasks().filter((task) => LONG_CONTEXT_TASKS.includes(task.id));
  if (tasks.length !== LONG_CONTEXT_TASKS.length) {
    console.error(`l-a-preview: 判分集里缺少长上下文题（期望 ${LONG_CONTEXT_TASKS.length}，找到 ${tasks.length}）`);
    process.exit(2);
  }
  const only = argOf("--tasks", null);
  const selected = only ? tasks.filter((task) => only.split(",").includes(task.id)) : tasks;
  const agentDir = prepareAgentDir();
  mkdirSync(RUNS_DIR, { recursive: true });

  console.log(`L-A 预演：${selected.length} 题 × ${Object.keys(STATES).length} 状态 = ${selected.length * 3} 次`);
  console.log(`独立 agent 目录：${agentDir}（会话不写 ~/.pi/agent/sessions）`);
  console.log(`结果目录：${path.relative(repoRoot, RUNS_DIR)}\n`);

  const startedAt = Date.now();
  let done = 0;
  const total = selected.length * Object.keys(STATES).length;
  for (const stateKey of Object.keys(STATES)) {
    for (const task of selected) {
      done += 1;
      const stateFile = path.join(STATE_DIR, `${stateKey}.jsonl`);
      if (!existsSync(stateFile)) {
        console.error(`缺少状态文件 ${stateFile}，先跑 --build`);
        process.exit(2);
      }
      // 每次 run 复制一份状态（agent 会往会话文件追加，不能污染素材）
      const perRunFile = path.join(tmpdir(), `piforge-la-${stateKey}-${task.id}-${Date.now().toString(36)}.jsonl`);
      writeFileSync(perRunFile, readFileSync(stateFile));
      const result = await runTask({
        task,
        arm: "control",
        round: 1,
        outDir: null,
        extraEnv: { PI_CODING_AGENT_DIR: agentDir },
        resumeSessionFile: perRunFile,
        // 历史里全是 `D:\Pi\PiForge\...` 绝对路径：不改写到工作树，模型会去改真实仓库。
        rewriteRepoPaths: true,
        labels: { state: stateKey },
      });
      // 跑后护栏：模型偶尔会照着历史里的绝对路径把改动写进**真实仓库**。
      // 一旦发现（tracked 文件被改），立刻回滚并给这次 run 打标。
      const status = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" });
      const leaked = status
        .split(String.fromCharCode(10))
        .map((line) => line.replace(String.fromCharCode(13), ""))
        .filter((line) => /^\s*[MADRC]/.test(line))
        .filter((line) => !line.includes("docs/") && !line.includes("scripts/"));
      if (leaked.length > 0) {
        // 只回滚被泄漏修改的那些文件（`git checkout -- .` 会连本次未提交的文档改动一起冲掉）
        const leakedPaths = leaked.map((line) => line.slice(3).trim()).filter(Boolean);
        execFileSync("git", ["checkout", "--", ...leakedPaths], { cwd: repoRoot, stdio: "ignore" });
        result.leakedRepo = leaked.slice(0, 5);
        console.warn(`  ! ${stateKey} ${task.id} 写进了真实仓库（已回滚 ${leaked.length} 个文件）`);
      }
      writeFileSync(path.join(RUNS_DIR, `${stateKey}__${task.id}.json`), `${JSON.stringify(result, null, 2)}\n`);
      console.log(
        `  [${done}/${total}] ${stateKey} ${task.id.padEnd(26)} ${result.passed ? "PASS" : "fail"} ` +
          `calls=${result.calls ?? 0} cacheReadMed=${result.cacheReadMedianPerCall ?? 0} ` +
          `miss=${((result.inputMissRatio ?? 0) * 100).toFixed(1)}% $${(result.cost ?? 0).toFixed(4)} ` +
          `${((result.durationMs ?? 0) / 1000).toFixed(0)}s${result.error ? ` err=${String(result.error).slice(0, 40)}` : ""}`,
      );
    }
  }
  console.log(`\n完成 ${total} 次，用时 ${((Date.now() - startedAt) / 60000).toFixed(0)} 分钟。`);
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

function report() {
  if (!existsSync(RUNS_DIR)) {
    console.error(`没有结果（${RUNS_DIR}）。先跑 --run。`);
    process.exit(2);
  }
  const runs = readdirSync(RUNS_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(path.join(RUNS_DIR, name), "utf8")));
  const byState = new Map();
  for (const run of runs) {
    const bucket = byState.get(run.state) ?? { state: run.state, runs: [] };
    bucket.runs.push(run);
    byState.set(run.state, bucket);
  }
  const order = ["C1", "C2", "C3"].filter((stateKey) => byState.has(stateKey));
  const table = order.map((stateKey) => {
    const rows = byState.get(stateKey).runs;
    return {
      state: stateKey,
      runs: rows.length,
      pass: rows.filter((row) => row.passed).length,
      cacheReadMedian: median(rows.map((row) => row.cacheReadMedianPerCall ?? 0)),
      inputMissMedian: Number(
        (median(rows.map((row) => Math.round((row.inputMissRatio ?? 0) * 10_000))) / 10_000).toFixed(4),
      ),
      callsMedian: median(rows.map((row) => row.calls ?? 0)),
      /** 首轮上下文：直接反映"压缩后还剩多少"（比 cacheRead 中位更少受模型行为干扰）。 */
      firstContextMedian: median(rows.map((row) => row.contextTokensFirst ?? 0)),
      /** 整题上下文总量：一题到底为上下文付了多少 token。 */
      totalContextMedian: median(rows.map((row) => row.contextTokensTotal ?? 0)),
      durationMedian: median(rows.map((row) => row.durationMs ?? 0)),
      costTotal: Number(rows.reduce((sum, row) => sum + (row.cost ?? 0), 0).toFixed(4)),
      errors: rows.filter((row) => row.error).length,
    };
  });

  console.log("L-A 预演汇总（每格 1 次，仅供判方向）");
  console.log(
    "| 状态 | 次数 | 通过 | 首轮上下文 | 整题上下文总量 | cacheRead 中位/调用 | 未命中 input | 调用数中位 | 耗时中位 | 成本 |",
  );
  console.log("|---|---|---|---|---|---|---|---|---|---|");
  for (const row of table) {
    console.log(
      `| ${row.state} | ${row.runs} | ${row.pass}/${row.runs} | ${row.firstContextMedian.toLocaleString()} | ` +
        `${row.totalContextMedian.toLocaleString()} | ${row.cacheReadMedian.toLocaleString()} | ` +
        `${(row.inputMissMedian * 100).toFixed(1)}% | ${row.callsMedian} | ${(row.durationMedian / 1000).toFixed(0)}s | ` +
        `$${row.costTotal} |`,
    );
  }

  const find = (stateKey) => table.find((row) => row.state === stateKey);
  const c1 = find("C1");
  const c2 = find("C2");
  const c3 = find("C3");
  if (c1 && c2) {
    const drop = ((c2.cacheReadMedian - c1.cacheReadMedian) / Math.max(1, c1.cacheReadMedian)) * 100;
    const c2Errors = c2.runs - c2.pass;
    const c1Errors = c1.runs - c1.pass;
    console.log("\n判据（预演级）");
    console.log(
      `  ${c2Errors <= c1Errors ? "PASS" : "FAIL"} C2 错题数不增加：${c1Errors} → ${c2Errors}`,
    );
    const dropFirst = ((c2.firstContextMedian - c1.firstContextMedian) / Math.max(1, c1.firstContextMedian)) * 100;
    console.log(
      `  ${drop <= -20 ? "PASS" : "FAIL"} C2 的 cacheRead 中位下降 ≥20%：${c1.cacheReadMedian} → ${c2.cacheReadMedian}（${drop.toFixed(1)}%）`,
    );
    console.log(
      `  （首轮上下文口径：${c1.firstContextMedian} → ${c2.firstContextMedian}，${dropFirst.toFixed(1)}%；` +
        `整题总量 ${c1.totalContextMedian} → ${c2.totalContextMedian}）`,
    );
    if (c3) {
      const extraErrors = (c3.runs - c3.pass) - c2Errors;
      console.log(
        `  拐点：C3 比 C2 多错 ${extraErrors} 题${extraErrors >= 2 ? "（≥2 → 压缩有风险，L-A 只能做到 C2 级别）" : "（<2 → 没看到明显拐点）"}`,
      );
    }
  }
  console.log("\n逐题（PASS/fail）：");
  const taskIds = [...new Set(runs.map((run) => run.task))];
  for (const taskId of taskIds) {
    const cells = order.map((stateKey) => {
      const run = runs.find((entry) => entry.task === taskId && entry.state === stateKey);
      return run ? (run.passed ? "PASS" : "fail") : "—";
    });
    console.log(`  ${taskId.padEnd(26)} ${cells.join("  ")}`);
  }
}

if (has("--build")) build();
else if (has("--run")) await run();
else if (has("--report")) report();
else {
  console.log("用法：node scripts/l-a-preview.mjs --build | --run | --report");
  console.log("  --build   构造 C1/C2/C3 三种压缩后状态（不花 token）");
  console.log("  --run     8 题 × 3 状态 = 24 次真实调用（约 $0.1）");
  console.log("  --report  汇总 + 判据");
}
