#!/usr/bin/env node
/**
 * L-C 观测：子 Agent 到底吃掉了多少 cacheRead？（把"未量化"变成数字）
 *
 * 背景（docs/optimizations/context-governance-plan.md 的 L-C 行）：上下文治理里
 * "subagent 上下文隔离"一直被标成"可能最大但未量化"。这个脚本负责量化。
 *
 * 关键事实：**子 Agent 不写会话文件**。
 *   agent-host/subagents.ts 用的是 `SessionManager.inMemory(cwd)`，父会话的 JSONL 里
 *   没有子 Agent 的 usage 记录。所以"从磁盘统计子 Agent token"这条路是**不存在**的
 *   —— 这也是为什么它一直是"未量化"而不是"算了但小"。
 *
 * 于是分三层量化（每层都写清口径，避免把推导当实测）：
 *   [实测] 1. 派发频率：60 个会话里有多少次 `spawn_agent` / `herdr_spawn` / `orchestrator_spawn`，
 *             以及"有派发的会话"和"没有派发的会话"的 parent cacheRead 对比；
 *   [实测] 2. 代码事实：子 Agent 的会话是否隔离（in-memory + noContextFiles + childSystemPrompt）、
 *             硬闸门（3 轮 / 单轮 10k 熔断 / 回包 ≤1200 字符）；
 *   [推导] 3. 上界：单次派发最多 3 轮 × 10 000 tok = 30 000 tok；
 *             拿它与父会话每调用 cacheRead 中位（142 976）比，得出"一次派发 ≈ 0.2 次父调用"。
 *
 * 用法：
 *   node scripts/audit-subagent-share.mjs                 # 最近 90 天
 *   node scripts/audit-subagent-share.mjs --days 365 --json
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const days = Number(getArg("--days", "90"));
const asJson = argv.includes("--json");

const sessionsRoot = path.join(homedir(), ".pi", "agent", "sessions");
const repoRoot = path.resolve(import.meta.dirname, "..");
const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

/** 派发类工具名（历史上换过三代：spawn_agent → orchestrator_* → herdr_*）。 */
const SPAWN_TOOLS = new Set([
  "spawn_agent",
  "orchestrator_spawn",
  "herdr_spawn",
  "fleet",
]);
/** 子 Agent 硬闸门（与 agent-host/agent-guards.ts 保持一致）。 */
const MAX_TURNS = 3;
const CONTEXT_BREAKER_TOKENS = 10_000;

function listSessions(dir, out = []) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listSessions(full, out);
    else if (entry.name.endsWith(".jsonl")) {
      try {
        if (statSync(full).mtimeMs >= cutoff) out.push(full);
      } catch {
        // 读不到就跳过
      }
    }
  }
  return out;
}

function parseSession(file) {
  const stats = {
    file,
    cwd: null,
    requests: 0,
    cacheRead: 0,
    /** 每次请求的 cacheRead，用于"请求级中位/p90"（会话均值会被长会话稀释）。 */
    perRequest: [],
    cost: 0,
    spawnCalls: 0,
    spawnNames: [],
    spawnCallIds: [],
    toolCalls: 0,
    /** 派发后首个 assistant 回复的上下文规模（用 cacheRead+input 近似），用于看"回包膨胀"。 */
    postSpawnContexts: [],
  };
  let lines = [];
  try {
    lines = readFileSync(file, "utf8").split("\n");
  } catch {
    return stats;
  }
  const callIndex = new Map();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "session") {
      stats.cwd = entry.cwd ?? stats.cwd;
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (!message) continue;
    const content = message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "toolCall") {
          stats.toolCalls += 1;
          if (SPAWN_TOOLS.has(block.name)) {
            stats.spawnCalls += 1;
            stats.spawnNames.push(block.name);
            if (block.id) {
              stats.spawnCallIds.push(block.id);
              callIndex.set(block.id, stats.requests);
            }
          }
        }
      }
    }
    if (message.role !== "assistant") continue;
    const usage = message.usage;
    if (!usage || typeof usage.input !== "number") continue;
    if ((usage.totalTokens ?? 0) === 0) continue;
    stats.requests += 1;
    stats.cacheRead += usage.cacheRead ?? 0;
    stats.perRequest.push(usage.cacheRead ?? 0);
    stats.cost += usage.cost?.total ?? 0;
    stats.postSpawnContexts.push((usage.input ?? 0) + (usage.cacheRead ?? 0));
  }
  return stats;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

function pct(numerator, denominator) {
  if (!denominator) return "n/a";
  return `${((numerator / denominator) * 100).toFixed(2)}%`;
}

/** [实测 2] 代码事实：子 Agent 是否已经隔离上下文（读源码，不做推测）。 */
function readIsolationFacts() {
  const facts = { inMemory: false, noContextFiles: false, childSystemPrompt: false, guards: [] };
  try {
    const source = readFileSync(path.join(repoRoot, "agent-host", "subagents.ts"), "utf8");
    facts.inMemory = /SessionManager\.inMemory\(/.test(source);
    facts.noContextFiles = /noContextFiles:\s*true/.test(source);
    facts.childSystemPrompt = /systemPrompt:\s*childSystemPrompt\(/.test(source);
  } catch {
    // 源码不可读时保持 false，报告里会写"未能确认"
  }
  try {
    const guards = readFileSync(path.join(repoRoot, "agent-host", "agent-guards.ts"), "utf8");
    if (/MAX_DISCUSSION_TURNS\s*=\s*3/.test(guards)) facts.guards.push(`轮数上限 = ${MAX_TURNS}`);
    if (/CONTEXT_BREAKER_TOKENS\s*=\s*10_000/.test(guards))
      facts.guards.push(`单轮上下文熔断 = ${CONTEXT_BREAKER_TOKENS.toLocaleString()} tok`);
    if (/MAX_PARENT_REPORT_CHARS\s*=\s*1_200/.test(guards)) facts.guards.push("回包摘要上限 = 1 200 字符");
  } catch {
    // 同上
  }
  return facts;
}

const files = listSessions(sessionsRoot);
const sessions = files.map(parseSession).filter((s) => s.requests > 0);

const totalCacheRead = sessions.reduce((sum, s) => sum + s.cacheRead, 0);
const totalRequests = sessions.reduce((sum, s) => sum + s.requests, 0);
const totalCost = sessions.reduce((sum, s) => sum + s.cost, 0);
const withSpawn = sessions.filter((s) => s.spawnCalls > 0);
const withoutSpawn = sessions.filter((s) => s.spawnCalls === 0);
const totalSpawnCalls = sessions.reduce((sum, s) => sum + s.spawnCalls, 0);

const cacheReadPerCall = (list) =>
  list.length === 0 ? 0 : Math.round(list.reduce((sum, s) => sum + s.cacheRead, 0) / Math.max(1, list.reduce((sum, s) => sum + s.requests, 0)));

/** [推导 3] 单次派发的成本上界 = 3 轮 × 10k 熔断。 */
const SUBAGENT_UPPER_PER_SPAWN = MAX_TURNS * CONTEXT_BREAKER_TOKENS;
const subagentUpperTotal = totalSpawnCalls * SUBAGENT_UPPER_PER_SPAWN;

const facts = readIsolationFacts();
/** 请求级口径（与 audit-token-usage 的 "cacheRead/call 中位" 同义，可比）。 */
const allPerRequest = sessions.flatMap((s) => s.perRequest);
const parentCacheReadMedian = median(allPerRequest);
const parentCacheReadP90 = (() => {
  if (allPerRequest.length === 0) return 0;
  const sorted = [...allPerRequest].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
})();
/** 会话级均值的中位（另一种口径，长会话会把它拉低，仅作参考）。 */
const sessionAverageMedian = median(sessions.map((s) => Math.round(s.cacheRead / Math.max(1, s.requests))));

/** 有派发的会话按 cacheRead 排 top5，用于看"派发是否与巨型上下文同时出现"。 */
const topSpawnSessions = [...withSpawn]
  .sort((a, b) => b.cacheRead - a.cacheRead)
  .slice(0, 5)
  .map((s) => ({
    session: path.basename(s.file).replace(/\.jsonl$/, "").slice(0, 44),
    dir: path.basename(path.dirname(s.file)),
    cwd: s.cwd,
    spawnCalls: s.spawnCalls,
    requests: s.requests,
    cacheRead: s.cacheRead,
    cacheReadPerCall: Math.round(s.cacheRead / Math.max(1, s.requests)),
    shareOfTotal: Number(((s.cacheRead / Math.max(1, totalCacheRead)) * 100).toFixed(2)),
  }));

const report = {
  window: { days, sessions: sessions.length, files: files.length },
  totals: { requests: totalRequests, cacheRead: totalCacheRead, cost: Number(totalCost.toFixed(4)) },
  spawn: {
    sessionsWithSpawn: withSpawn.length,
    sessionShare: Number(((withSpawn.length / Math.max(1, sessions.length)) * 100).toFixed(2)),
    calls: totalSpawnCalls,
    byName: sessions.flatMap((s) => s.spawnNames).reduce((acc, name) => {
      acc[name] = (acc[name] ?? 0) + 1;
      return acc;
    }, {}),
    callSharePct: Number(((totalSpawnCalls / Math.max(1, sessions.reduce((sum, s) => sum + s.toolCalls, 0))) * 100).toFixed(3)),
  },
  parentComparison: {
    cacheReadPerCallWithSpawn: cacheReadPerCall(withSpawn),
    cacheReadPerCallWithoutSpawn: cacheReadPerCall(withoutSpawn),
    cacheReadMedianPerCall: parentCacheReadMedian,
    cacheReadP90PerCall: parentCacheReadP90,
    sessionAverageMedian,
    costShareOfSpawnSessions: Number(((withSpawn.reduce((sum, s) => sum + s.cost, 0) / Math.max(1e-9, totalCost)) * 100).toFixed(2)),
    cacheReadShareOfSpawnSessions: Number(((withSpawn.reduce((sum, s) => sum + s.cacheRead, 0) / Math.max(1, totalCacheRead)) * 100).toFixed(2)),
  },
  derived: {
    upperPerSpawn: SUBAGENT_UPPER_PER_SPAWN,
    upperTotal: subagentUpperTotal,
    upperShareOfObservedCacheRead: Number(((subagentUpperTotal / Math.max(1, totalCacheRead)) * 100).toFixed(3)),
    spawnEquivalentParentCalls: Number((SUBAGENT_UPPER_PER_SPAWN / Math.max(1, parentCacheReadMedian)).toFixed(2)),
  },
  isolationFacts: facts,
  topSpawnSessions,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const lines = [];
lines.push(`L-C 观测（最近 ${days} 天）`);
lines.push(`会话 ${report.window.sessions} 个 · 请求 ${totalRequests.toLocaleString()} 次 · cacheRead ${totalCacheRead.toLocaleString()} tok · 成本 $${report.totals.cost}`);
lines.push("");
lines.push("[实测 1] 派发频率");
lines.push(`  有派发的会话：${report.spawn.sessionsWithSpawn} / ${report.window.sessions}（${report.spawn.sessionShare}%）`);
lines.push(`  派发调用合计：${report.spawn.calls} 次（按工具名：${JSON.stringify(report.spawn.byName)}）`);
lines.push(`  占全部工具调用：${report.spawn.callSharePct}%`);
lines.push("");
lines.push("[实测 1b] 有派发 vs 无派发的父会话对比（每调用 cacheRead）");
lines.push(`  有派发：${report.parentComparison.cacheReadPerCallWithSpawn.toLocaleString()} tok/调用（占 cacheRead ${report.parentComparison.cacheReadShareOfSpawnSessions}%，占成本 ${report.parentComparison.costShareOfSpawnSessions}%）`);
lines.push(`  无派发：${report.parentComparison.cacheReadPerCallWithoutSpawn.toLocaleString()} tok/调用`);
lines.push(
  `  请求级中位：${report.parentComparison.cacheReadMedianPerCall.toLocaleString()} tok/调用（p90 ${report.parentComparison.cacheReadP90PerCall.toLocaleString()}）`,
);
lines.push(`  会话级均值的中位：${report.parentComparison.sessionAverageMedian.toLocaleString()} tok/调用（长会话稀释，仅参考）`);
lines.push("");
lines.push("[实测 2] 子 Agent 上下文的代码事实（agent-host/subagents.ts）");
lines.push(`  in-memory 会话（不落盘、不继承父 transcript）：${facts.inMemory ? "是" : "否"}`);
lines.push(`  noContextFiles（不读父级上下文文件）：${facts.noContextFiles ? "是" : "否"}`);
lines.push(`  独立 childSystemPrompt：${facts.childSystemPrompt ? "是" : "否"}`);
lines.push(`  硬闸门：${facts.guards.join(" · ") || "未能确认"}`);
lines.push("");
lines.push("[推导 3] 单次派发的成本上界");
lines.push(`  上界 = ${MAX_TURNS} 轮 × ${CONTEXT_BREAKER_TOKENS.toLocaleString()} tok = ${SUBAGENT_UPPER_PER_SPAWN.toLocaleString()} tok`);
lines.push(`  合计上界 ${subagentUpperTotal.toLocaleString()} tok ≈ 观测 cacheRead 的 ${report.derived.upperShareOfObservedCacheRead}%`);
lines.push(`  一次派发 ≈ ${report.derived.spawnEquivalentParentCalls} 次父调用（父调用中位 ${parentCacheReadMedian.toLocaleString()} tok）`);
lines.push("");
lines.push("[参考] 派发最多的 5 个会话");
for (const s of topSpawnSessions) {
  lines.push(
    `  ${s.session} · ${s.spawnCalls} 次派发 · ${s.requests} 调用 · cacheRead ${s.cacheRead.toLocaleString()}（${s.cacheReadPerCall.toLocaleString()}/调用，${s.shareOfTotal}% 总量）`,
  );
}
lines.push("");
lines.push("结论：见 docs/optimizations/context-governance-plan.md 的 L-C 行。");
console.log(lines.join("\n"));
