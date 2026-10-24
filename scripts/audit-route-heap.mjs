#!/usr/bin/env node
/**
 * 路由首载 **heap 增量**归档（Step 4「host ≤220 MB」的立项材料）。
 *
 *   node scripts/audit-route-heap.mjs                 # 人类可读（top 15）
 *   node scripts/audit-route-heap.mjs --json          # 机读（全部路由）
 *   node scripts/audit-route-heap.mjs --json --out docs/optimizations/route-heap.json
 *
 * 做法：起一个真实 Agent Host（dist 产物，独立命名管道 + 随机 token），
 * 用最小的客户端把每条路由 **GET 一次**（动态段填占位值，让 handler 尽早返回），
 * 记录该路由 **模块首载** 前后的 `process.memoryUsage().heapUsed` 增量与耗时。
 *
 * 为什么用占位参数：我们要的是"这条路由把哪些模块变成常驻"的代价，
 * 而不是某次具体业务调用的代价；路由加载发生在 handler 之前，与参数无关。
 * POST-only 路由无法安全地"空跑"，只从静态图谱（audit-route-deps）里取字节数，
 * heapDelta 记为 null 并在输出里标注。
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const outIndex = args.indexOf("--out");
const outFile = outIndex === -1 ? null : args[outIndex + 1];
const topIndex = args.indexOf("--top");
const top = topIndex === -1 ? 15 : Number(args[topIndex + 1]);

const repoRoot = process.cwd();
const entry = path.join(repoRoot, "agent-host", "dist", "agent-host", "index.js");
const routesFile = path.join(repoRoot, "agent-host", "api-routes.generated.ts");

if (!existsSync(entry)) {
  console.error("audit-route-heap: 缺少 agent-host/dist（先 npm run build:agent-host）");
  process.exit(1);
}

/** 从生成的表里取路径模式（不执行 TS）。 */
function readPatterns() {
  const source = readFileSync(routesFile, "utf8");
  return [...source.matchAll(/pattern: "([^"]+)"/g)].map((m) => m[1]);
}

const BS = String.fromCharCode(92);
const endpoint = `${BS}${BS}.${BS}pipe${BS}piforge-heap-${process.pid}`;
const token = "h".repeat(32);

const child = spawn(process.execPath, ["--expose-gc", entry], {
  env: {
    ...process.env,
    PIFORGE_AGENT_ENDPOINT: endpoint,
    PIFORGE_AGENT_TOKEN: token,
    // 让 Host 在 api.request 的返回里带上自己的 heapUsed（见 agent-host/server.ts）。
    PIFORGE_HEAP_PROBE: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", () => {});
child.stderr.on("data", () => {});

async function connect() {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      const socket = net.connect(endpoint);
      await new Promise((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      return socket;
    } catch {
      // 还没起来
    }
  }
  throw new Error("agent-host 未就绪");
}

const socket = await connect();
socket.setEncoding("utf8");
let buffer = "";
let nextId = 0;
const pending = new Map();
socket.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    if (frame.kind === "ping") {
      socket.write(`${JSON.stringify({ kind: "pong", nonce: frame.nonce })}\n`);
      continue;
    }
    if (frame.kind === "res" && pending.has(frame.id)) {
      const resolve = pending.get(frame.id);
      pending.delete(frame.id);
      resolve(frame);
    }
  }
});
socket.write(
  `${JSON.stringify({ kind: "hello", protocolVersion: 1, token, client: { pid: process.pid, role: "cli" } })}\n`,
);
await new Promise((resolve) => setTimeout(resolve, 500));

function call(method, params) {
  return new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    socket.write(`${JSON.stringify({ kind: "req", id, method, params })}\n`);
  });
}

/** `:id` / `*rest` 换成占位值（路由加载与参数无关）。 */
function concreteUrl(pattern) {
  const filled = pattern
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) return "probe-missing-id";
      if (segment.startsWith("*")) return "probe/missing/path";
      return segment;
    })
    .join("/");
  return `piforge://app${filled}`;
}

const patterns = readPatterns();
const results = [];
/** Host 的 heapUsed 是单调累积量：差值 = 这条路由首载带来的增量。 */
let previousHeapKb = null;
for (const pattern of patterns) {
  const started = performance.now();
  const frame = await call("api.request", {
    method: "GET",
    url: concreteUrl(pattern),
    headers: {},
  });
  const ms = Math.round(performance.now() - started);
  const status = frame?.result?.status ?? null;
  const rawHeap = Number(frame?.result?.hostHeapUsed ?? 0);
  const hostHeapKb = rawHeap > 0 ? Math.round(rawHeap / 1024) : null;
  results.push({
    route: pattern,
    status,
    ms,
    hostHeapKb,
    heapDeltaKb: hostHeapKb !== null && previousHeapKb !== null ? hostHeapKb - previousHeapKb : null,
  });
  if (hostHeapKb !== null) previousHeapKb = hostHeapKb;
}

socket.destroy();
child.kill("SIGKILL");

if (results.every((row) => row.hostHeapKb === null)) {
  console.error(
    "audit-route-heap: Host 没有回报 heap —— 需要 agent-host/api-router.ts 在 PIFORGE_DEBUG_API=1 时\n" +
      "把首载后的 process.memoryUsage() 一起回给调用方（见 api.request 的 debugHeap 字段）。",
  );
  process.exit(2);
}

results.sort((a, b) => (b.heapDeltaKb ?? -1) - (a.heapDeltaKb ?? -1));
const payload = { generatedAt: new Date().toISOString(), routes: results };
if (outFile) writeFileSync(path.join(repoRoot, outFile), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
if (asJson) console.log(JSON.stringify(payload, null, 2));
else {
  console.log(`路由首载 heap 归档（${results.length} 条，Host 侧 heapUsed）\n`);
  console.log("路由                                          状态   耗时ms  heap增量KB  累计KB");
  for (const row of results.slice(0, top)) {
    console.log(
      `${row.route.padEnd(44)} ${String(row.status ?? "-").padStart(4)}  ${String(row.ms).padStart(6)}  ${String(row.heapDeltaKb ?? "-").padStart(10)}  ${String(row.hostHeapKb ?? "-").padStart(7)}`,
    );
  }
}
