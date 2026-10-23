/**
 * Agent Host 的**传输层双实现**（L1 补完）。
 *
 * 背景：`utilityProcess.fork()` 的 `execArgv` 只能带**一个** `--js-flags`，
 * 所以新生代（semi-space）收不下去，host 卡在 264–284 MB（见 electron/host-heap.ts）。
 * 同一份 host 用 `ELECTRON_RUN_AS_NODE=1` 跑成普通子进程后，`NODE_OPTIONS` 里的
 * **两个** V8 flag 都生效 —— 实测 heap limit 280 MB、空闲 RSS 115–116 MB
 * （`node scripts/probe-host-runtime.mjs`，报告见
 * docs/optimizations/l1-run-as-node-probe.md）。
 *
 * 本模块只做"决策 + 拼启动规格"，纯函数、不 import Electron，便于单测：
 *   - `resolveHostTransport()`：读 `PIFORGE_HOST_TRANSPORT`，**默认 utility**；
 *   - `hostRuntimePlan()`：按传输层给出真正生效的 V8 参数（utility 只能老生代，
 *     node 模式新生代+老生代都能设）；
 *   - `buildHostSpawnSpec()`：node 模式的命令行 / 环境变量 / 参数；
 *   - `hostShutdownFrame()`：node 模式下关闭走 stdin 的一行 JSON（与 parentPort 等价）。
 *
 * ⚠️ `ELECTRON_RUN_AS_NODE` **只写进 host 自己的 env**，绝不写进 `process.env`：
 * 否则主进程之后拉起的所有子进程都会变成 node 模式。host 侧再用
 * `agent-host/child-env.ts` 把它从受管进程的环境里剔掉（双保险）。
 */

export type HostTransport = "utility" | "node";

export type HostTransportCode = "default_utility" | "env_utility" | "env_node" | "invalid_env";

export interface HostTransportDecision {
  transport: HostTransport;
  code: HostTransportCode;
  reason: string;
}

/**
 * 解析 `PIFORGE_HOST_TRANSPORT`：
 *   - 未设置 / 空 → **utility（默认，行为与切默认前完全一致）**
 *   - `utility`   → utility
 *   - `node`      → ELECTRON_RUN_AS_NODE 子进程
 *   - 其它值      → 回落 utility，并在 `reason` 里写明（不静默改行为）
 */
export function resolveHostTransport(input: { env?: Record<string, string | undefined> } = {}): HostTransportDecision {
  const raw = input.env?.PIFORGE_HOST_TRANSPORT?.trim().toLowerCase();
  if (!raw) return { transport: "utility", code: "default_utility", reason: "默认 utilityProcess" };
  if (raw === "utility") return { transport: "utility", code: "env_utility", reason: "PIFORGE_HOST_TRANSPORT=utility" };
  if (raw === "node") return { transport: "node", code: "env_node", reason: "PIFORGE_HOST_TRANSPORT=node" };
  return {
    transport: "utility",
    code: "invalid_env",
    reason: `PIFORGE_HOST_TRANSPORT="${raw}" 无法识别（只认 utility|node），回落 utilityProcess`,
  };
}

export interface HostHeapPlan {
  semiSpaceMb: number | null;
  oldSpaceMb: number | null;
}

export interface HostRuntimePlan {
  /** utility 模式传给 `utilityProcess.fork` 的 execArgv。 */
  execArgv: string[];
  /** node 模式写进子进程环境变量的 `NODE_OPTIONS`（`null` = 不设）。 */
  nodeOptions: string | null;
  /** node 模式必须放在**脚本路径之前**的运行时参数（例如 `--cpu-prof`）。 */
  runtimeFlags: string[];
  /** 实际生效的堆上限（写日志 / OOM 证据用）。 */
  effective: {
    heapLimitMb: number | null;
    semiSpaceMb: number | null;
    oldSpaceMb: number | null;
  };
  notes: string[];
}

/** V8 堆上限 ≈ old-space + 新生代预留（实测 256 → 280 / 352，见 host-heap.ts）。 */
function estimateHeapLimitMb(plan: HostHeapPlan, transport: HostTransport): number | null {
  if (plan.oldSpaceMb === null) return null;
  if (transport === "node" && plan.semiSpaceMb !== null) return plan.oldSpaceMb + 24;
  return plan.oldSpaceMb + 96;
}

/**
 * 按传输层给出可用的 V8 参数。差别只有一处，但很关键：
 *   - utility：只能 `--js-flags=--max-old-space-size=N`（单 flag），新生代**设不了**；
 *   - node：`NODE_OPTIONS` 里两个 flag 都生效。
 */
export function hostRuntimePlan(input: {
  transport: HostTransport;
  heap: HostHeapPlan;
  extraRuntimeFlags?: string[];
  existingNodeOptions?: string;
}): HostRuntimePlan {
  const { transport, heap } = input;
  const extra = input.extraRuntimeFlags ?? [];
  const notes: string[] = [];

  if (transport === "utility") {
    const execArgv: string[] = [];
    if (heap.oldSpaceMb !== null) execArgv.push(`--js-flags=--max-old-space-size=${heap.oldSpaceMb}`);
    execArgv.push(...extra);
    if (heap.semiSpaceMb !== null) {
      notes.push("utility 传输层只能设老生代：`--js-flags` 多 flag 会被 Electron 重拼命令行拆开");
    }
    return {
      execArgv,
      nodeOptions: null,
      runtimeFlags: [],
      effective: { heapLimitMb: estimateHeapLimitMb(heap, transport), semiSpaceMb: null, oldSpaceMb: heap.oldSpaceMb },
      notes,
    };
  }

  const flags: string[] = [];
  if (heap.oldSpaceMb !== null) flags.push(`--max-old-space-size=${heap.oldSpaceMb}`);
  if (heap.semiSpaceMb !== null) flags.push(`--max-semi-space-size=${heap.semiSpaceMb}`);
  const kept = (input.existingNodeOptions ?? "")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .filter((part) => !part.startsWith("--max-old-space-size") && !part.startsWith("--max-semi-space-size"));
  const nodeOptions = [...kept, ...flags].join(" ");
  if (heap.semiSpaceMb !== null) notes.push("node 传输层：新生代 + 老生代都生效（实测 limit 280MB）");
  return {
    execArgv: [],
    nodeOptions: nodeOptions.length > 0 ? nodeOptions : null,
    runtimeFlags: extra,
    effective: { heapLimitMb: estimateHeapLimitMb(heap, transport), semiSpaceMb: heap.semiSpaceMb, oldSpaceMb: heap.oldSpaceMb },
    notes,
  };
}

export interface HostSpawnSpec {
  transport: HostTransport;
  /** node 模式的可执行文件（dev 是 electron.exe，打包是 PiForge.exe）；utility 模式为 null。 */
  command: string | null;
  /** node 模式：[...runtimeFlags, entry]；utility 模式：[]（由 `utilityProcess.fork(entry)` 传）。 */
  args: string[];
  env: Record<string, string>;
  execArgv: string[];
  nodeOptions: string | null;
  effective: HostRuntimePlan["effective"];
  notes: string[];
  reason: string;
}

/**
 * 拼出启动规格。node 模式的环境变量里**只在这里**加 `ELECTRON_RUN_AS_NODE`。
 */
export function buildHostSpawnSpec(input: {
  decision: HostTransportDecision;
  entry: string;
  env: Record<string, string>;
  /** `process.execPath`：Electron/打包版可执行文件，加 ELECTRON_RUN_AS_NODE 后即 node 运行时。 */
  binaryPath: string;
  heap: HostHeapPlan;
  extraRuntimeFlags?: string[];
}): HostSpawnSpec {
  const plan = hostRuntimePlan({
    transport: input.decision.transport,
    heap: input.heap,
    extraRuntimeFlags: input.extraRuntimeFlags,
    existingNodeOptions: input.env.NODE_OPTIONS,
  });

  if (input.decision.transport === "utility") {
    // utility：环境里绝不能出现 ELECTRON_RUN_AS_NODE / NODE_OPTIONS 的堆参数
    // （Electron 会把 NODE_OPTIONS 从 utilityProcess 环境剥掉，留着只会误导排障）。
    const env = { ...input.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_RUN_AS_NODE_ENABLED;
    return {
      transport: "utility",
      command: null,
      args: [],
      env,
      execArgv: plan.execArgv,
      nodeOptions: null,
      effective: plan.effective,
      notes: plan.notes,
      reason: input.decision.reason,
    };
  }

  const env: Record<string, string> = {
    ...input.env,
    ELECTRON_RUN_AS_NODE: "1",
    /**
     * 明确告诉 host「父进程会用 stdin 传控制帧」。
     *
     * 不能靠"stdin 不是 TTY"猜：探针/冒烟脚本用 `stdio: ["ignore", ...]` 启动时，
     * stdin 是一个**立刻关闭**的管道，host 会把它当成"父进程已经死了"而秒退。
     * 所以通道开关必须是显式的（这条踩过一次，见 docs/optimizations/l1-transport-implementation.md）。
     */
    PIFORGE_HOST_STDIN_CONTROL: "1",
  };
  if (plan.nodeOptions) env.NODE_OPTIONS = plan.nodeOptions;
  else delete env.NODE_OPTIONS;

  return {
    transport: "node",
    command: input.binaryPath,
    args: [...plan.runtimeFlags, input.entry],
    env,
    execArgv: [],
    nodeOptions: plan.nodeOptions,
    effective: plan.effective,
    notes: plan.notes,
    reason: input.decision.reason,
  };
}

/**
 * node 模式的关闭指令：走 stdin 的一行 JSON，内容与 utility 的
 * `child.postMessage({type:"shutdown"})` 一一对应（host 侧同一个处理函数）。
 *
 * 协议规格在 `contract/host-stdin.ts`（host 侧 import 它）。这里没法直接 re-export：
 * electron/tsconfig 的 rootDir 就是 electron/，不能跨目录引 `.ts`。
 * 两份实现的一致性由 `electron/host-launcher.test.ts` 逐字节断言。
 */
export function hostShutdownFrame(reason = "app-quit"): string {
  return `${JSON.stringify({ type: "shutdown", reason })}
`;
}

export function parseHostStdinLine(line: string): { type: "shutdown"; reason?: string } | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as { type?: unknown; reason?: unknown };
  if (record.type !== "shutdown") return null;
  return { type: "shutdown", ...(typeof record.reason === "string" ? { reason: record.reason } : {}) };
}
