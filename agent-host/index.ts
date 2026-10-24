/**
 * Agent Host entry point.
 *
 * Runs as an Electron `utilityProcess` in the desktop app, and as a plain
 * Node process under `scripts/dev.mjs` / the handshake smoke test. It must not
 * import Electron APIs — only the contract and Node built-ins.
 */
import { appendFileSync } from "node:fs";
import { PerformanceObserver } from "node:perf_hooks";
import v8 from "node:v8";
import process from "node:process";
import { PROTOCOL_VERSION, type ParentMessage } from "../contract/protocol.ts";
// server.ts 只在 main() 里动态 import：它牵出 Pi SDK 整张模块图（2 万文件），
// 静态 import 会让下面所有打点都落在"图加载完之后"，量不到真正的启动段。
import { parseHostStdinLine } from "../contract/host-stdin.ts";
import { hostPhase } from "./host-phases.ts";

interface ParentPort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): void;
}

function log(message: string): void {
  console.log(`[agent-host] ${message}`);
}

function logError(message: string, detail?: unknown): void {
  console.error(`[agent-host] ${message}`, detail ?? "");
}

/**
 * 诊断：`PIFORGE_DEBUG_HOST_CPU=1` 时每 5s 打一条自身 CPU/RSS/活跃句柄。
 * 用来回答"空闲时这 6% CPU 到底是谁在烧"——外部采样只能看到进程级总量。
 */
/** 只统计 GC 次数/耗时（perf_hooks），用于 soak 时判断"堆压小了是不是 scavenge 变多"。 */
const gcStats = { count: 0, totalMs: 0, maxMs: 0 };

function startGcHistogram(): void {
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        gcStats.count += 1;
        gcStats.totalMs += entry.duration;
        if (entry.duration > gcStats.maxMs) gcStats.maxMs = entry.duration;
      }
    });
    observer.observe({ entryTypes: ["gc"] });
    // 观测器常驻，不 unref（它本身不产生句柄）。
  } catch {
    // 某些运行时没有 GC 观测能力：忽略，不影响主流程。
  }
}

/**
 * OOM 取证：把"堆爆"的证据落盘到 `<userData>/host-oom.json`（由 Main 通过
 * `PIFORGE_HOST_OOM_FILE` 指定），用于 L1（收紧 V8 堆）后的 soak 校验。
 *
 * 只在真正的堆耗尽时写（`isHeapExhaustion` 判定），普通崩溃不污染这个文件。
 */
function recordOomEvidence(source: string, error: unknown): void {
  const file = process.env.PIFORGE_HOST_OOM_FILE?.trim();
  if (!file) return;
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? "");
  const lower = message.toLowerCase();
  const looksLikeOom =
    lower.includes("heap out of memory") ||
    lower.includes("allocation failed") ||
    (lower.includes("fatal error") && lower.includes("heap"));
  if (!looksLikeOom) return;
  const memory = process.memoryUsage();
  const record = {
    at: new Date().toISOString(),
    source,
    message,
    limits: {
      maxOldSpaceMb: Number(process.env.PIFORGE_HOST_HEAP_OLD_MB ?? 0) || null,
      maxSemiSpaceMb: Number(process.env.PIFORGE_HOST_HEAP_SEMI_MB ?? 0) || null,
    },
    memory: {
      rssMb: Math.round(memory.rss / 1048576),
      heapUsedMb: Math.round(memory.heapUsed / 1048576),
      heapTotalMb: Math.round(memory.heapTotal / 1048576),
      externalMb: Math.round(memory.external / 1048576),
    },
    gc: { count: gcStats.count, totalMs: Math.round(gcStats.totalMs), maxMs: Math.round(gcStats.maxMs) },
  };
  try {
    appendFileSync(file, `${JSON.stringify(record)}
`, "utf8");
  } catch {
    // 取证失败不能影响退出流程
  }
}

function startCpuDiagnostics(): void {
  let last = process.cpuUsage();
  let lastAt = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const elapsedMs = Math.max(1, now - lastAt);
    lastAt = now;
    // `process.cpuUsage(prev)` 返回相对 prev 的差值（微秒）。
    const delta = process.cpuUsage(last);
    last = process.cpuUsage();
    const percent = ((delta.user + delta.system) / 1000 / elapsedMs) * 100;
    const memory = process.memoryUsage();
    const resources = process.getActiveResourcesInfo();
    const counts: Record<string, number> = {};
    for (const name of resources) counts[name] = (counts[name] ?? 0) + 1;
    console.log(
      `[host-cpu] ${percent.toFixed(2)}% over=${elapsedMs}ms rss=${(memory.rss / 1048576).toFixed(0)}MB ` +
        `heapUsed=${(memory.heapUsed / 1048576).toFixed(0)}MB ` +
        `heapTotal=${(memory.heapTotal / 1048576).toFixed(0)}MB ` +
        `external=${(memory.external / 1048576).toFixed(0)}MB ` +
        `arrayBuffers=${(memory.arrayBuffers / 1048576).toFixed(0)}MB ` +
        `gc=${gcStats.count}/${Math.round(gcStats.totalMs)}ms/${Math.round(gcStats.maxMs)}ms ` +
        `resources=${JSON.stringify(counts)}`,
    );
    // 1s 粒度：burst 与"稳定占用"必须能分开看，5s 的平均值会把一次性峰值摊平。
  }, 1_000);
  timer.unref?.();
}

/**
 * node 传输层的关闭通道：utilityProcess 用 `parentPort.postMessage({type:"shutdown"})`，
 * 普通子进程没有 parentPort，所以改读 stdin 的一行 JSON（同一个处理函数）。
 * 另外 stdin 被父进程关闭（`end()` / 父进程死亡）时也要退，避免成孤儿。
 */
function startStdinControl(onShutdown: (reason: string) => void): void {
  if (process.stdin.isTTY) return;
  process.stdin.setEncoding("utf8");
  const newline = String.fromCharCode(10);
  let buffer = "";
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf(newline);
    while (index !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const command = parseHostStdinLine(line);
      if (command?.type === "shutdown") onShutdown(command.reason ?? "parent request");
      index = buffer.indexOf(newline);
    }
  });
  process.stdin.on("end", () => onShutdown("parent closed stdin"));
  process.stdin.on("error", () => onShutdown("stdin error"));
  process.stdin.resume();
}

function getParentPort(): ParentPort | undefined {
  return (process as unknown as { parentPort?: ParentPort }).parentPort;
}

async function main(): Promise<void> {
  // 阶段打点：ms 均相对进程启动，delta 是阶段净耗时（见 host-phases.ts）。
  hostPhase("node.bootstrap");

  const endpoint = process.env.PIFORGE_AGENT_ENDPOINT?.trim();
  const token = process.env.PIFORGE_AGENT_TOKEN?.trim();
  if (!endpoint || !token) {
    logError("PIFORGE_AGENT_ENDPOINT and PIFORGE_AGENT_TOKEN are required");
    process.exit(2);
  }

  startGcHistogram();

  /**
   * L1 取证：确认 V8 堆参数真的生效（Electron 的 `utilityProcess.execArgv` 只有
   * `--js-flags=<单个 flag>` 形式会应用，见 electron/host-heap.ts 的实测记录）。
   */
  {
    const stats = v8.getHeapStatistics();
    console.log(
      `[agent-host] heap flags: execArgv=${JSON.stringify(process.execArgv)} ` +
        `limitMb=${Math.round(stats.heap_size_limit / 1048576)} ` +
        `totalAvailableMb=${Math.round(stats.total_available_size / 1048576)}`,
    );
  }

  /**
   * 新生代大小**不在这里调**：实测 `v8.setFlagsFromString("--max-semi-space-size=8")`
   * 会把 Chromium 在 V8 初始化时应用的 `--js-flags=--max-old-space-size=192` 一起冲掉
   * （host 的 heap_size_limit 从 288 MB 回到 4192 MB）。所以只保留 js-flags 里的老生代。
   */
  if (process.env.PIFORGE_DEBUG_HOST_CPU === "1") startCpuDiagnostics();

  const { createAgentHostServer } = await import("./server.ts");
  hostPhase("server.module");

  const parentPort = getParentPort();
  let shuttingDown = false;
  const server = createAgentHostServer({
    endpoint,
    token,
    log,
    onReady: (readyEndpoint) => {
      hostPhase("ready");
      log(`ready protocol=${PROTOCOL_VERSION} endpoint=${readyEndpoint}`);
      parentPort?.postMessage({
        type: "host_ready",
        endpoint: readyEndpoint,
        protocolVersion: PROTOCOL_VERSION,
        pid: process.pid,
      });
    },
    onFatal: (error) => {
      logError("fatal server error", error);
    },
  });

  const shutdown = async (reason: string, code = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutting down (${reason})`);
    try {
      await server.close();
    } catch (error) {
      logError("error while closing server", error);
    }
    process.exit(code);
  };

  parentPort?.on("message", (event) => {
    const message = event.data as ParentMessage | null;
    if (message && typeof message === "object" && message.type === "shutdown") {
      void shutdown(message.reason ?? "parent request");
    }
  });

  // node 传输层（PIFORGE_HOST_TRANSPORT=node）：没有 parentPort，改读 stdin。
  // 必须由启动方显式开启：`stdio: ["ignore"]` 启动时 stdin 会立刻 end，
  // 若把"end"当成"父进程死了"，host 会秒退（探针/冒烟就是这么启动的）。
  if (!parentPort && process.env.PIFORGE_HOST_STDIN_CONTROL === "1") {
    startStdinControl((reason) => void shutdown(reason));
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("uncaughtException", (error) => {
    recordOomEvidence("uncaughtException", error);
    logError("uncaught exception", error);
    void shutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", (reason) => {
    recordOomEvidence("unhandledRejection", reason);
    logError("unhandled rejection", reason);
    void shutdown("unhandledRejection", 1);
  });

  try {
    await server.start();
  } catch (error) {
    logError("failed to start", error);
    process.exit(1);
  }
}

void main();
