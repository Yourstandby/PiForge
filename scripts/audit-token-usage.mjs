#!/usr/bin/env node
/**
 * Token 消耗审计（只读：解析真实会话 JSONL，不改任何机制）。
 *
 *   node scripts/audit-token-usage.mjs                  # 最近 7 天
 *   node scripts/audit-token-usage.mjs --days 14 --json
 *
 * 三类问题（对应 docs/optimizations/token-consumption-audit.md）：
 *   (a) 空闲恢复重发：距上一次请求 >= --idle-gap 分钟的请求，未命中缓存的部分要重发；
 *   (b) 跨 app / 跨工具集导致的前缀失效：cacheRead 相对上一条骤降（<10%）且未命中 input 变大；
 *   (c) output 分布：按"这条 assistant 消息发起了哪些工具"粗分任务类型，
 *       看哪类任务 output 偏高（PAD 每 call 1 140 tok vs PiForge 668 tok）。
 *
 * 数据口径：`~/.pi/agent/sessions/**\/*.jsonl` 里 `type: "message"` 的 assistant 条目，
 * `message.usage = { input, output, cacheRead, cacheWrite, reasoning, totalTokens, cost }`。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : Number(args[index + 1]);
};
const days = flag("--days", 7);
const idleGapMinutes = flag("--idle-gap", 10);
const asJson = args.includes("--json");

const sessionsRoot = path.join(homedir(), ".pi", "agent", "sessions");
const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

function listSessions(dir) {
  const out = [];
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSessions(full));
    else if (entry.name.endsWith(".jsonl")) {
      try {
        if (statSync(full).mtimeMs >= cutoff) out.push(full);
      } catch {
        // 忽略读不到的文件
      }
    }
  }
  return out;
}

function parseSession(file) {
  const requests = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
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
    const usage = message.usage;
    if (!usage || typeof usage.input !== "number") continue;
    if ((usage.totalTokens ?? 0) === 0) continue;
    const tools = [];
    for (const block of message.content ?? []) {
      if (block && typeof block === "object" && block.type === "toolCall") {
        tools.push(String(block.name ?? "unknown"));
      }
    }
    requests.push({
      at: Date.parse(entry.timestamp),
      input: usage.input ?? 0,
      output: usage.output ?? 0,
      cacheRead: usage.cacheRead ?? 0,
      cacheWrite: usage.cacheWrite ?? 0,
      reasoning: usage.reasoning ?? 0,
      total: usage.totalTokens ?? 0,
      cost: usage.cost?.total ?? 0,
      costInput: usage.cost?.input ?? 0,
      costOutput: usage.cost?.output ?? 0,
      costCacheRead: usage.cost?.cacheRead ?? 0,
      tools,
      hasText: (message.content ?? []).some((b) => b?.type === "text" && (b.text ?? "").length > 0),
    });
  }
  return requests.sort((a, b) => a.at - b.at);
}

/** 任务类型：按工具组合粗分（审计够用即可，不追求精确分类）。 */
function classify(request) {
  const tools = request.tools;
  if (tools.length === 0) return request.hasText ? "纯回答（无工具）" : "空转";
  const has = (name) => tools.some((tool) => tool.includes(name));
  if (has("edit") || has("write") || has("apply")) return "改代码（edit/write）";
  if (has("bash") || has("shell") || has("powershell")) return "跑命令（shell/bash）";
  if (has("web") || has("browser")) return "网页/浏览器";
  if (has("read") || has("grep") || has("glob") || has("ls") || has("list")) return "只读探查（read/grep）";
  return `其它（${[...new Set(tools)].slice(0, 2).join(",")}）`;
}

const sessionFiles = listSessions(sessionsRoot);
const sessions = sessionFiles
  .map((file) => ({ file, requests: parseSession(file) }))
  .filter((session) => session.requests.length > 0);

const totals = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  total: 0,
  cost: 0,
  costInput: 0,
  costOutput: 0,
  costCacheRead: 0,
};
const idleResumes = [];
const prefixInvalidations = [];
const byType = new Map();

for (const session of sessions) {
  let previous = null;
  for (const request of session.requests) {
    totals.input += request.input;
    totals.output += request.output;
    totals.cacheRead += request.cacheRead;
    totals.cacheWrite += request.cacheWrite;
    totals.reasoning += request.reasoning;
    totals.total += request.total;
    totals.cost += request.cost;
    totals.costInput += request.costInput;
    totals.costOutput += request.costOutput;
    totals.costCacheRead += request.costCacheRead;

    const type = classify(request);
    const bucket = byType.get(type) ?? { type, calls: 0, output: 0, input: 0, cacheRead: 0 };
    bucket.calls += 1;
    bucket.output += request.output;
    bucket.input += request.input;
    bucket.cacheRead += request.cacheRead;
    byType.set(type, bucket);

    if (previous) {
      const gapMinutes = (request.at - previous.at) / 60_000;
      if (gapMinutes >= idleGapMinutes) {
        idleResumes.push({
          session: path.basename(session.file).replace(/\.jsonl$/, ""),
          gapMinutes: Math.round(gapMinutes),
          resentInput: request.input,
          resentCost: request.costInput,
          cacheRead: request.cacheRead,
          previousCacheRead: previous.cacheRead,
          at: new Date(request.at).toISOString(),
        });
      }
      // 前缀失效：上一条读了大缓存，这一条 cacheRead 掉到 10% 以下，且未命中部分明显变大。
      if (previous.cacheRead >= 20_000 && request.cacheRead < previous.cacheRead * 0.1 && request.input >= 10_000) {
        prefixInvalidations.push({
          session: path.basename(session.file).replace(/\.jsonl$/, ""),
          at: new Date(request.at).toISOString(),
          previousCacheRead: previous.cacheRead,
          cacheRead: request.cacheRead,
          resentInput: request.input,
          resentCost: request.costInput,
          cacheWrite: request.cacheWrite,
        });
      }
    }
    previous = request;
  }
}

const sessionSummaries = sessions.map((session) => {
  const calls = session.requests.length;
  const tokens = session.requests.reduce(
    (acc, request) => {
      acc.input += request.input;
      acc.output += request.output;
      acc.cacheRead += request.cacheRead;
      acc.total += request.total;
      acc.cost += request.cost;
      return acc;
    },
    { input: 0, output: 0, cacheRead: 0, total: 0, cost: 0 },
  );
  return {
    session: path.basename(session.file).replace(/\.jsonl$/, ""),
    dir: path.basename(path.dirname(session.file)),
    calls,
    ...tokens,
    costPerCall: calls > 0 ? tokens.cost / calls : 0,
    avgContextPerCall: calls > 0 ? Math.round(tokens.cacheRead / calls) : 0,
  };
}).sort((a, b) => b.cost - a.cost);

const sumOf = (list, key) => list.reduce((acc, item) => acc + item[key], 0);
const median = (values) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[middle - 1] + sorted[middle]) / 2) : sorted[middle];
};

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

const callCount = sessions.reduce((count, session) => count + session.requests.length, 0);
const outputByType = [...byType.values()]
  .map((bucket) => ({
    ...bucket,
    meanOutput: Math.round(bucket.output / Math.max(1, bucket.calls)),
    outputShare: totals.output > 0 ? Math.round((bucket.output / totals.output) * 100) : 0,
  }))
  .sort((a, b) => b.output - a.output);

const payload = {
  window: { days, sessionFiles: sessions.length, requests: callCount },
  totals,
  unitPrice: {
    input: totals.input > 0 ? totals.costInput / totals.input : 0,
    output: totals.output > 0 ? totals.costOutput / totals.output : 0,
    cacheRead: totals.cacheRead > 0 ? totals.costCacheRead / totals.cacheRead : 0,
  },
  cache: {
    cacheReadShare: totals.total > 0 ? Math.round((totals.cacheRead / totals.total) * 100) : 0,
    uncachedInputShare: totals.total > 0 ? Math.round((totals.input / totals.total) * 100) : 0,
  },
  idleResume: {
    count: idleResumes.length,
    resentInputTotal: sumOf(idleResumes, "resentInput"),
    resentCost: sumOf(idleResumes, "resentCost"),
    medianGapMinutes: median(idleResumes.map((item) => item.gapMinutes)),
    top: [...idleResumes].sort((a, b) => b.resentInput - a.resentInput).slice(0, 5),
  },
  prefixInvalidation: {
    count: prefixInvalidations.length,
    resentInputTotal: sumOf(prefixInvalidations, "resentInput"),
    resentCost: sumOf(prefixInvalidations, "resentCost"),
    top: [...prefixInvalidations].sort((a, b) => b.resentInput - a.resentInput).slice(0, 5),
  },
  context: {
    cacheReadPerCall: {
      median: median(sessions.flatMap((session) => session.requests.map((request) => request.cacheRead))),
      p90: percentile(sessions.flatMap((session) => session.requests.map((request) => request.cacheRead)), 0.9),
      max: Math.max(0, ...sessions.flatMap((session) => session.requests.map((request) => request.cacheRead))),
    },
    topSessions: sessionSummaries.slice(0, 8),
  },
  output: {
    medianPerCall: median(sessions.flatMap((session) => session.requests.map((request) => request.output))),
    meanPerCall: Math.round(totals.output / Math.max(1, callCount)),
    byType: outputByType,
  },
};

if (asJson) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log(`Token 审计（最近 ${days} 天，${payload.window.sessionFiles} 个会话 / ${payload.window.requests} 次模型调用）\n`);
  console.log("总量");
  console.log(
    `  input(未命中) ${totals.input.toLocaleString()}   cacheRead ${totals.cacheRead.toLocaleString()}   cacheWrite ${totals.cacheWrite.toLocaleString()}`,
  );
  console.log(
    `  output ${totals.output.toLocaleString()}（其中 reasoning ${totals.reasoning.toLocaleString()}）   total ${totals.total.toLocaleString()}   cost $${totals.cost.toFixed(4)}`,
  );
  console.log(`  缓存命中占比 ${payload.cache.cacheReadShare}%  ·  未命中 input 占比 ${payload.cache.uncachedInputShare}%`);
  const costPct = (value) => (totals.cost > 0 ? Math.round((value / totals.cost) * 100) : 0);
  console.log(
    `  成本拆解：output ${costPct(totals.costOutput)}% ($${totals.costOutput.toFixed(2)}) · input ${costPct(totals.costInput)}% ($${totals.costInput.toFixed(2)}) · cacheRead ${costPct(totals.costCacheRead)}% ($${totals.costCacheRead.toFixed(2)})`,
  );
  console.log(
    `  实测单价：input $${payload.unitPrice.input.toExponential(2)} / output $${payload.unitPrice.output.toExponential(2)} / cacheRead $${payload.unitPrice.cacheRead.toExponential(2)}`,
  );
  console.log();

  console.log(
    `(a) 空闲恢复重发（间隔 >=${idleGapMinutes} 分钟）：${payload.idleResume.count} 次，重发 ${payload.idleResume.resentInputTotal.toLocaleString()} tok / $${payload.idleResume.resentCost.toFixed(2)}，间隔中位 ${payload.idleResume.medianGapMinutes} 分钟`,
  );
  for (const item of payload.idleResume.top) {
    console.log(
      `    ${item.at}  gap=${item.gapMinutes}m  未命中 input=${item.resentInput.toLocaleString()}  (上一条 cacheRead=${item.previousCacheRead.toLocaleString()})`,
    );
  }
  console.log(
    `
(b) 前缀失效（cacheRead 骤降 + 大 input）：${payload.prefixInvalidation.count} 次，重发 ${payload.prefixInvalidation.resentInputTotal.toLocaleString()} tok / $${payload.prefixInvalidation.resentCost.toFixed(2)}`,
  );
  for (const item of payload.prefixInvalidation.top) {
    console.log(
      `    ${item.at}  cacheRead ${item.previousCacheRead.toLocaleString()}→${item.cacheRead.toLocaleString()}  重发 input=${item.resentInput.toLocaleString()}  cacheWrite=${item.cacheWrite.toLocaleString()}`,
    );
  }
  console.log(`\n(c) output 分布（每次调用中位 ${payload.output.medianPerCall} tok、均值 ${payload.output.meanPerCall} tok）`);
  console.log("    任务类型                  调用数  output 合计   output 占比  每次均值");
  for (const bucket of payload.output.byType) {
    console.log(
      `    ${bucket.type.padEnd(24)} ${String(bucket.calls).padStart(5)}  ${String(bucket.output).padStart(11)}  ${String(bucket.outputShare).padStart(10)}%  ${String(bucket.meanOutput).padStart(8)}`,
    );
  }
}
