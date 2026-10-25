#!/usr/bin/env node
/**
 * 超长会话实测（真实模型）。
 *
 * 干的事：起一个真实的 Agent Host（用你自己的 auth.json），跑 N 轮带工具调用的对话，
 * 每轮结束从 `agent.state` 读回 sessionStats 并与上一轮做差，得到**逐轮**
 * input / cacheRead / cacheWrite / output。同时记录前缀审计与缓存保活状态。
 *
 * 只读取、不改任何 PiForge 代码；会话写进临时 agentDir，不污染你的 ~/.pi。
 *
 * 用法：
 *   node scripts/measure-long-session.mjs --model deepseek-flash --turns 30 \
 *     --pause-every 10 --pause-ms 60000 --out docs/measurements/long-session.json
 *
 *   # 对比旧版本：先 git worktree add tmp/v082 v0.8.2 && 在那里 build:agent-host
 *   node scripts/measure-long-session.mjs --host tmp/v082/agent-host/dist/agent-host/index.js \
 *     --label v0.8.2 --out docs/measurements/long-session-v082.json
 *
 * 退出码：0 正常；1 环境/运行失败；2 auth 缺失；3 命中率断言失败。
 */
import { spawnNodeHost } from "./lib/host-spawn.mjs";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const valueOf = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

const hostEntry = path.resolve(
  valueOf("--host") ?? path.join(repoRoot, "agent-host", "dist", "agent-host", "index.js")
);
const label = valueOf("--label") ?? "HEAD";
const provider = valueOf("--provider") ?? "deepseek";
const modelId = valueOf("--model") ?? "deepseek-flash";
const turns = Number(valueOf("--turns") ?? 30);
const pauseEvery = Number(valueOf("--pause-every") ?? 0);
const pauseMs = Number(valueOf("--pause-ms") ?? 0);
const cwd = path.resolve(valueOf("--cwd") ?? repoRoot);
const outFile = valueOf("--out");
const minHitRate = Number(valueOf("--min-hit-rate") ?? 0);
/** 稳定段每轮未缓存 input 的中位数上限（0 = 不检查）。 */
const maxMedianInput = Number(valueOf("--max-median-input") ?? 0);
/** CI 里没有 ~/.pi/auth.json：允许用环境变量提供凭据。 */
const envApiKey = process.env.DEEPSEEK_API_KEY?.trim();
/** 第 8 步 A/B 用：把 prompt 换成「中频域（shell）真的会被调用 4 次」的一组。 */
const scenario = valueOf("--scenario") ?? "default";
const TIMEOUT_MS = 180_000;

/** 30 轮的任务脚本：每轮都真的需要工具，且第 3 / 17 轮会触发按需域激活。 */
const DEFAULT_PROMPTS = [
  "读 package.json，只回答 version 字段的值。",
  "用 bash 跑 `echo pi-long-session`，只回答输出。",
  "用 memory 工具回忆关于 token 预算的项目记忆（先搜索工具再调用），只回答命中的条数。",
  "grep 一下仓库里 `cacheWarming` 出现的文件数量（只给数字）。",
  "读 agent-host/cache-warming.ts 的前 40 行，用一句话概括它做什么。",
  "列一下 agent-host 目录下名字以 desktop- 开头的文件有几个。",
  "用 bash 看 `git rev-parse --short HEAD`，只回答哈希。",
  "读 docs/measurements/README.md 的标题行（# 开头），原样回答。",
  "grep `prefixAudit` 在 agent-host 下出现的次数。",
  "用 bash 统计 `ls components | wc -l`，只回答数字。",
  "读 lib/domain-tools.ts 里 ON_DEMAND_DOMAINS 的值，原样回答。",
  "用 bash 跑 `node -e \"console.log(1+1)\"`，只回答结果。",
  "grep `applyCacheWarmingPolicy` 的定义在哪个文件。",
  "读 app/api/settings/route.ts 里 cacheWarming 那一行，原样回答。",
  "用 bash 看 `git status --short | wc -l`，只回答数字。",
  "读 components/TitleBar.tsx 的前 10 行，回答它是不是客户端组件。",
  "用 orchestrator 工具查看当前有没有 worker（先搜索工具再调用），只回答结论。",
  "用 bash 跑 `date +%Y-%m-%d`，只回答日期。",
  "grep `staleTime` 在 hooks 下出现的文件数量。",
  "读 tsconfig.json 里的 target 值。",
  "用 bash 看 `wc -l agent-host/rpc-manager.ts`，只回答数字。",
  "读 lib/approval-policy.ts 里 PLAN_TOOLS 数组，原样回答。",
  "grep `PIFORGE_DEBUG_PREFIX` 出现的文件路径（最多 3 个）。",
  "用 bash 跑 `git log --oneline -1`，原样回答。",
  "读 docs/measurements/README.md 里「静态前缀」那一行表格，原样回答。",
  "用 bash 统计 `rg -c cacheRead agent-host 2>/dev/null | wc -l`。",
  "grep `promptCache` 在 node_modules 之外出现的次数。",
  "读 agent-host/desktop-approval-extension.ts 的 import 区块，回答引入了几个本地模块。",
  "用 bash 跑 `ls docs/measurements`，原样回答文件名。",
  "总结：刚才这 29 轮里你一共调用过哪些工具（名字列表）。",
];

/** shell 域专用的 30 轮脚本：前 8 轮里真实调用 run/read/wait 4 次，其余保持真实工作。 */
const ON_DEMAND_PROMPTS = [
  "启动一个后台常驻进程跑 `node -e \"setInterval(()=>{},1000)\"`。必须使用 shell 工具：如果你当前没有 shell 工具，先用 tool_search 搜索 shell（它会在下一轮生效），下一轮再调用 shell 的 run 动作；不要用 bash 替代。只回答 processId 的前 8 位。",
  "用 shell 工具的 read 动作读一下上一步那个进程的日志前 10 行。",
  "读 package.json 的 version 字段，只回答值。",
  "用 bash 跑 `echo plain-bash`，只回答输出。",
  "grep 一下 agent-host 目录里 `cacheWarming` 出现的文件数量，只给数字。",
  "再用 shell 工具的 run 动作起一个后台进程跑 `node -e \"console.log('ready')\"`（没有 shell 工具就先 tool_search），拿到 processId 后只回答前 8 位。",
  "用 shell 工具的 wait 动作（for=exit）等上一个进程结束，只回答退出码。",
  "用 bash 看 `git rev-parse --short HEAD`，只回答哈希。",
  "读 docs/measurements/README.md 的第一个标题行，原样回答。",
  "grep `prefixAudit` 在 agent-host 下出现的次数。",
  "用 bash 统计 `ls components | wc -l`，只回答数字。",
  "读 lib/domain-tools.ts 里 ON_DEMAND_DOMAINS 的值，原样回答。",
  "用 bash 跑 `node -e \"console.log(2+2)\"`，只回答结果。",
  "grep `applyCacheWarmingPolicy` 的定义在哪个文件。",
  "读 app/api/settings/route.ts 里 cacheWarming 那一行，原样回答。",
  "用 bash 看 `git status --short | wc -l`，只回答数字。",
  "读 components/TitleBar.tsx 的前 10 行，回答它是不是客户端组件。",
  "用 bash 跑 `date +%Y-%m-%d`，只回答日期。",
  "grep `staleTime` 在 hooks 下出现的文件数量。",
  "读 tsconfig.json 里的 target 值。",
  "用 bash 看 `wc -l agent-host/rpc-manager.ts`，只回答数字。",
  "读 lib/approval-policy.ts 里 PLAN_TOOLS 数组，原样回答。",
  "grep `PIFORGE_DEBUG_PREFIX` 出现的文件路径（最多 3 个）。",
  "用 bash 跑 `git log --oneline -1`，原样回答。",
  "读 docs/measurements/README.md 里「静态前缀」那一行表格，原样回答。",
  "用 bash 统计 `rg -c cacheRead agent-host 2>/dev/null | wc -l`。",
  "grep `promptCache` 在 node_modules 之外出现的次数。",
  "读 agent-host/desktop-approval-extension.ts 的 import 区块，回答引入了几个本地模块。",
  "用 bash 跑 `ls docs/measurements`，原样回答文件名。",
  "总结：刚才这些轮里你一共调用过哪些工具（名字列表）。",
];

const PROMPTS = scenario === "on-demand" ? ON_DEMAND_PROMPTS : DEFAULT_PROMPTS;

/** 从会话 JSONL 里统计工具调用次数（用来确认 A/B 的调用序列/频率）。 */
function tallyToolCalls(sessionFile) {
  const tally = {};
  if (!sessionFile || !existsSync(sessionFile)) return tally;
  const lines = readFileSync(sessionFile, "utf8").split(String.fromCharCode(10)).filter(Boolean);
  const walk = (value) => {
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value;
    if (record.type === "toolCall") {
      const name = typeof record.name === "string" ? record.name : record.toolName;
      if (typeof name === "string") tally[name] = (tally[name] ?? 0) + 1;
    }
    for (const entry of Object.values(record)) walk(entry);
  };
  for (const line of lines) {
    try {
      walk(JSON.parse(line));
    } catch {
      /* 跳过损坏行 */
    }
  }
  return tally;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createEndpoint() {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\piforge-long-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  }
  const dir = mkdtempSync(path.join(tmpdir(), "piforge-long-"));
  return path.join(dir, "agent-host.sock");
}

function waitForReady(child, logs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error("host did not report ready")), TIMEOUT_MS);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    child.stdout.on("data", (chunk) => {
      logs.push(chunk.toString("utf8"));
      if (logs.join("").includes("[agent-host] ready")) finish(null);
    });
    child.stderr.on("data", (chunk) => logs.push(chunk.toString("utf8")));
    child.once("exit", (code) => finish(new Error(`host exited before ready (code ${code})`)));
    child.once("error", finish);
  });
}

function createClient(endpoint) {
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint);
    let buffer = "";
    const pending = [];
    const waiters = [];
    const deliver = (frame) => {
      if (frame.kind === "ping") {
        socket.write(`${JSON.stringify({ kind: "pong", nonce: frame.nonce })}\n`);
        return;
      }
      const waiter = waiters.shift();
      if (waiter) waiter(frame);
      else pending.push(frame);
    };
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) {
          try {
            deliver(JSON.parse(line));
          } catch {
            /* ignore */
          }
        }
        index = buffer.indexOf("\n");
      }
    });
    const next = () => {
      if (pending.length > 0) return Promise.resolve(pending.shift());
      return new Promise((done) => waiters.push(done));
    };
    socket.once("error", reject);
    socket.once("connect", () =>
      resolve({
        send: (frame) => socket.write(`${JSON.stringify(frame)}\n`),
        waitFor: async (predicate) => {
          for (;;) {
            const frame = await next();
            if (predicate(frame)) return frame;
          }
        },
      })
    );
  });
}

async function waitIdle(client, sessionId, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    client.send({ kind: "req", id: 950, method: "agent.state", params: { sessionId } });
    const frame = await client.waitFor((entry) => entry.kind === "res" && entry.id === 950);
    const state = frame?.result?.state;
    if (state && state.isStreaming !== true) return state;
    await sleep(250);
  }
  return null;
}

async function main() {
  if (!existsSync(hostEntry)) {
    console.error(`missing ${hostEntry} (run npm run build:agent-host)`);
    process.exit(1);
  }
  // Windows 上 process.env.HOME 可能指向 MSYS 的假家目录，优先 USERPROFILE。
const homeDir = process.env.USERPROFILE ?? process.env.HOME ?? "";
const sourceAuth = path.join(
  process.env.PI_CODING_AGENT_DIR ?? path.join(homeDir, ".pi", "agent"),
  "auth.json"
);
  if (!envApiKey && !existsSync(sourceAuth)) {
    console.error(
      `no auth.json at ${sourceAuth} and no DEEPSEEK_API_KEY — 真实模型实测需要登录凭据`
    );
    process.exit(2);
  }

  const agentDir = mkdtempSync(path.join(tmpdir(), "piforge-long-agent-"));
  mkdirSync(agentDir, { recursive: true });
  if (envApiKey) {
    writeFileSync(
      path.join(agentDir, "auth.json"),
      `${JSON.stringify({ deepseek: { type: "api_key", key: envApiKey } }, null, 2)}
`
    );
  } else {
    copyFileSync(sourceAuth, path.join(agentDir, "auth.json"));
  }
  writeFileSync(
    path.join(agentDir, "settings.json"),
    `${JSON.stringify({ defaultProvider: provider, defaultModel: modelId, defaultProjectTrust: "always", cacheWarming: "idle" }, null, 2)}\n`
  );

  const endpoint = createEndpoint();
  const token = `long-${Math.random().toString(36).slice(2)}`;
  const logs = [];
  const child = spawnNodeHost({
    entry: hostEntry,
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PI_CODING_AGENT_DIR: agentDir,
      PIFORGE_AGENT_ENDPOINT: endpoint,
      PIFORGE_AGENT_TOKEN: token,
    },
  });

  const rows = [];
  let sessionId = "";
  /** 最后一次 agent.state（会话文件路径、缓存状态都在里面）。 */
  let state = null;
  let sessionToolTally = {};
  try {
    await waitForReady(child, logs);
    const client = await createClient(endpoint);
    client.send({ kind: "hello", protocolVersion: 1, token, client: { pid: process.pid, role: "cli" } });
    const hello = await client.waitFor((frame) => frame.kind === "hello_ok" || frame.kind === "hello_error");
    if (hello.kind !== "hello_ok") throw new Error(`handshake failed: ${JSON.stringify(hello)}`);

    client.send({
      kind: "req",
      id: 1,
      method: "agent.create",
      params: { cwd, agentMode: "full", toolPreset: "default", provider, modelId, command: { type: "prompt", message: PROMPTS[0] } },
    });
    const created = await client.waitFor((frame) => frame.kind === "res" && frame.id === 1);
    if (!created.ok) throw new Error(`agent.create failed: ${JSON.stringify(created)}`);
    sessionId = created.result.sessionId;

    let previous = null;
    for (let turn = 1; turn <= turns; turn += 1) {
      if (turn > 1) {
        const ready = await waitIdle(client, sessionId);
        if (!ready) throw new Error(`turn ${turn}: session never became idle`);
        if (pauseEvery > 0 && (turn - 1) % pauseEvery === 0 && pauseMs > 0) {
          console.log(`  … 停顿 ${Math.round(pauseMs / 1000)}s（模拟用户离开）`);
          await sleep(pauseMs);
        }
        const before = Date.now();
        client.send({
          kind: "req",
          id: 100 + turn,
          method: "agent.command",
          params: { sessionId, command: { type: "prompt", message: PROMPTS[(turn - 1) % PROMPTS.length] } },
        });
        const ack = await client.waitFor((frame) => frame.kind === "res" && frame.id === 100 + turn);
        if (ack?.ok === false) throw new Error(`turn ${turn} rejected: ${JSON.stringify(ack)}`);
        void before;
      }
      state = await waitIdle(client, sessionId);
      if (!state) throw new Error(`turn ${turn}: no state`);
      const stats = state.sessionStats ?? { tokens: {}, cost: {} };
      const tokens = stats.tokens ?? {};
      const delta = {
        input: (tokens.input ?? 0) - (previous?.input ?? 0),
        cacheRead: (tokens.cacheRead ?? 0) - (previous?.cacheRead ?? 0),
        cacheWrite: (tokens.cacheWrite ?? 0) - (previous?.cacheWrite ?? 0),
        output: (tokens.output ?? 0) - (previous?.output ?? 0),
      };
      previous = { ...tokens };
      const contextTokens = state.contextUsage?.tokens ?? null;
      const prefix = state.prefixAudit ?? null;
      rows.push({
        turn,
        delta,
        contextTokens,
        cacheHitRate:
          delta.cacheRead + delta.cacheWrite + delta.input > 0
            ? (delta.cacheRead / (delta.cacheRead + delta.cacheWrite + delta.input)) * 100
            : null,
        cacheWarming: state.cacheWarming ?? null,
        prefixAudit: prefix,
        model: state.model ?? null,
      });
      process.stdout.write(
        `  turn ${String(turn).padStart(2)}: in=${String(delta.input).padStart(6)} read=${String(delta.cacheRead).padStart(6)} write=${String(delta.cacheWrite).padStart(5)} out=${String(delta.output).padStart(4)} ctx=${String(contextTokens ?? "-").padStart(6)} ${state.cacheWarming?.state ?? ""}\n`
      );
    }
    // 会话文件在临时 agentDir 里，必须在清理前读。
    sessionToolTally = tallyToolCalls(state?.sessionFile);
  } finally {
    try {
      child.kill();
    } catch {
      /* gone */
    }
    if (logs.length > 0 && process.env.PIFORGE_DEBUG_HOST === "1") {
      console.error(logs.join("").split("\n").slice(-30).join("\n"));
    }
    try {
      rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* keep temp dir */
    }
  }

  // 认证/配额失败时 provider 不报错、只是没有任何输出：显式失败，避免 CI 静默变绿。
  const producedOutput = rows.some((row) => row.delta.output > 0);
  if (!producedOutput) {
    console.error("no model output in any turn — 检查凭据 / 配额 / 网络（不做命中率断言）");
    process.exit(2);
  }

  // 稳定段命中率：跳过第 1 轮（冷启动）与任何 cacheWrite 明显的轮次（激活/前缀变化）。
  const stable = rows.filter((row) => row.turn > 1 && row.delta.cacheWrite <= Math.max(200, row.delta.input));
  const totals = stable.reduce(
    (acc, row) => {
      acc.read += row.delta.cacheRead;
      acc.write += row.delta.cacheWrite;
      acc.input += row.delta.input;
      return acc;
    },
    { read: 0, write: 0, input: 0 }
  );
  const denominator = totals.read + totals.write + totals.input;
  const hitRate = denominator > 0 ? (totals.read / denominator) * 100 : 0;

  const inputs = stable.map((row) => row.delta.input).sort((a, b) => a - b);
  const medianInput =
    inputs.length === 0
      ? 0
      : inputs.length % 2 === 1
        ? inputs[(inputs.length - 1) / 2]
        : Math.round((inputs[inputs.length / 2 - 1] + inputs[inputs.length / 2]) / 2);

  const toolTally = sessionToolTally;
  const report = {
    label,
    provider,
    modelId,
    turns,
    measuredAt: new Date().toISOString(),
    stableTurns: stable.length,
    stableHitRate: Number(hitRate.toFixed(2)),
    medianInputTokens: medianInput,
    scenario,
    toolTally,
    totals: { ...totals, denominator },
    rows,
  };
  if (outFile) {
    mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    writeFileSync(path.resolve(outFile), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\n写入 ${outFile}`);
  }
  console.log(`\n稳定段（${stable.length} 轮）cacheRead 命中率: ${hitRate.toFixed(1)}%`);
  console.log(`median uncached input per stable turn: ${medianInput} tok`);
  console.log(
    `tool calls: ${Object.entries(toolTally)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `${name}×${count}`)
      .join(", ")}`
  );
  if (minHitRate > 0 && hitRate < minHitRate) {
    console.error(`低于阈值 ${minHitRate}%`);
    process.exit(3);
  }
  if (maxMedianInput > 0 && medianInput > maxMedianInput) {
    console.error(`每轮未缓存 input 中位数 ${medianInput} 超过上限 ${maxMedianInput}`);
    process.exit(4);
  }
  if (!sessionId) process.exit(1);
}

await main();
