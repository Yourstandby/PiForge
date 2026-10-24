/**
 * Agent Host 的 V8 堆参数（Step 4 · L1）。
 *
 * 为什么是这里：`host` 的 RSS 里很大一块是 **V8 新生代（semi-space）与老生代的
 * 预留/arena**，不是活对象 —— 本机实测（打包版空闲、已加载一个会话）：
 *
 *   heapUsed 93 MB   heapTotal 143 MB   external 9 MB   rss 304 MB
 *
 * 也就是说 `rss − heapTotal − external ≈ 152 MB` 是 native/V8 预留，而
 * `heapTotal − heapUsed ≈ 50 MB` 是纯 GC 余量。收紧这两个上限能直接把 RSS 砍下来：
 *
 *   | V8 flags                                             | host RSS      | 空闲 CPU |
 *   | 默认                                                  | 289–357 MB    | 0.00–1.48% |
 *   | --max-semi-space-size=8                               | 205–264 MB    | 0.25%      |
 *   | --max-semi-space-size=8 --max-old-space-size=192       | 173–195 MB    | 0.25–0.49% |
 *
 * 取舍：semi-space 变小 → 新生代更容易满 → scavenge 更频繁；old-space 变小 →
 * 长会话堆积时可能 OOM。所以：
 *   1. 默认只给 **host**（utilityProcess）设，不动 main / 渲染进程；
 *   2. `PIFORGE_HOST_HEAP` 可覆盖（`default` = 不加任何参数，用于回退/排障）；
 *   3. OOM 必须留证据（`agent-host/index.ts` 写 `<userData>/host-oom.json`）。
 *
 * 纯函数：不 import Electron，便于单测。
 */

/**
 * 默认值**按传输层分档**：
 *   - utility：只能设老生代 → 8 / 256（新生代的 8 不生效，只用于日志与 OOM 取证）；
 *   - node：新生代 + 老生代都生效 → 4 / 192（30 轮 soak 验证：RSS 中位 216.9 MB、
 *     峰值 252.9 MB、空闲 CPU 中位 0.35%、0 OOM，见 docs/optimizations/l1-transport-implementation.md）。
 *
 * 为什么 node 敢用更小的新生代：新生代只影响 scavenge 频率，4 MB 时实测 CPU 仍是 0.35%；
 * 而 utility 想设也设不了，所以那边保持 8/256 不动。
 */
export const DEFAULT_HOST_HEAP = {
  maxSemiSpaceSizeMb: 8,
  maxOldSpaceSizeMb: 256,
} as const;

/** node 传输层的默认档（soak 已通过）。 */
export const NODE_HOST_HEAP = {
  maxSemiSpaceSizeMb: 4,
  maxOldSpaceSizeMb: 192,
} as const;

/** soak 通过后的激进档（老生代 192 + 新生代 8；保留给手工对比用）。 */
export const TIGHT_HOST_HEAP = {
  maxSemiSpaceSizeMb: 8,
  maxOldSpaceSizeMb: 192,
} as const;

export interface HostHeapFlags {
  /**
   * 传给 `utilityProcess.fork` 的 execArgv。
   *
   * ⚠️ 唯一可行的写法是 **`--js-flags=<空格分隔的 V8 flag>`**。以下三种都试过且**不生效**
   * （host 里 `v8.getHeapStatistics().heap_size_limit` 仍是 4192 MB）：
   *   1. `execArgv: ["--max-old-space-size=256"]`（普通 V8 flag 直接塞 execArgv）；
   *   2. host 环境里 `NODE_OPTIONS=...`（Electron 会把它从 utilityProcess 环境剥掉，
   *      host 读到 `null`）；
   *   3. 主进程 `app.commandLine.appendSwitch("js-flags", ...)`（V8 在 app 代码之前
   *      就已经初始化，改不动；而且那是全局的，渲染进程也会受影响）。
   *
   * 生效写法实测：`execArgv: ["--js-flags=--max-semi-space-size=8 --max-old-space-size=256"]`
   * → host `heap_size_limit` 4192 → **352 MB**；逗号分隔会被 V8 当成非法 flag 静默丢弃。
   */
  execArgv: string[];
  /** 决策依据（写日志，便于事后核对）。 */
  reason: string;
  /** 生效的数值（`null` = 未设置）。 */
  semiSpaceMb: number | null;
  oldSpaceMb: number | null;
}

interface HostHeapInput {
  env?: Record<string, string | undefined>;
  /** 额外参数（例如 `--cpu-prof`）；会拼在堆参数之后。 */
  extraFlags?: string[];
  /**
   * 传输层：决定"默认档"（`PIFORGE_HOST_HEAP` 显式给了就一律以它为准）。
   * 不传 = utility（保持历史行为）。
   */
  transport?: "utility" | "node";
}

function readPositive(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

/**
 * 解析 `PIFORGE_HOST_HEAP`：
 *   - 未设置            → 默认 8 / 256
 *   - `default` / `0`   → 不加任何堆参数（回退到 Chromium/Node 默认）
 *   - `semi=4,old=128`  → 自定义
 */
export function resolveHostHeapFlags(input: HostHeapInput = {}): HostHeapFlags {
  const env = input.env ?? {};
  const raw = env.PIFORGE_HOST_HEAP?.trim();

  const baseline = input.transport === "node" ? NODE_HOST_HEAP : DEFAULT_HOST_HEAP;
  let semi: number | null = baseline.maxSemiSpaceSizeMb;
  let old: number | null = baseline.maxOldSpaceSizeMb;
  let reason = `default-${input.transport ?? "utility"}(${baseline.maxSemiSpaceSizeMb}/${baseline.maxOldSpaceSizeMb}MB)`;

  if (raw !== undefined && raw !== "") {
    if (raw === "default" || raw === "0") {
      semi = null;
      old = null;
      reason = "PIFORGE_HOST_HEAP=default（不干预 V8 堆，回退用）";
    } else {
      const parts = raw.split(",").map((part) => part.trim().toLowerCase());
      const parsedSemi = readPositive(parts.find((part) => part.startsWith("semi="))?.slice("semi=".length));
      const parsedOld = readPositive(parts.find((part) => part.startsWith("old="))?.slice("old=".length));
      if (parsedSemi === null && parsedOld === null) {
        // 无法解析：保持默认而不是"静默不设"，并说明原因。
        reason = `PIFORGE_HOST_HEAP="${raw}" 无法解析，回落到 default(${semi}/${old}MB)`;
      } else {
        if (parsedSemi !== null) semi = parsedSemi;
        if (parsedOld !== null) old = parsedOld;
        reason = `PIFORGE_HOST_HEAP=${raw}`;
      }
    }
  }

  /**
   * ⚠️ `--js-flags` 只能带**一个** V8 flag：Electron 的 utilityProcess 会把 execArgv
   * 元素重新拼成命令行，带空格的多 flag 会被拆开（实测 `--js-flags=A B` 时
   * `heap_size_limit` 仍是 4192 MB，只有单 flag 生效）。
   *
   * 所以老生代走 js-flags（实测 4192 → 288 MB），新生代由 host 启动时用
   * `v8.setFlagsFromString("--max-semi-space-size=N")` 补上（运行时仍可调）。
   */
  const execArgv: string[] = [];
  if (old !== null) execArgv.push(`--js-flags=--max-old-space-size=${old}`);
  execArgv.push(...(input.extraFlags ?? []));

  return { execArgv, reason, semiSpaceMb: semi, oldSpaceMb: old };
}

/**
 * 把堆参数合并进继承来的 `NODE_OPTIONS`：
 *   - 先剔掉已有的 `--max-old-space-size` / `--max-semi-space-size`（避免两份冲突）；
 *   - 保留用户/环境原有的其它选项。
 */
export function mergeNodeOptions(existing: string | undefined, flags: readonly string[]): string | undefined {
  const heapFlags = flags.filter((flag) => flag.startsWith("--max-old-space-size") || flag.startsWith("--max-semi-space-size"));
  if (heapFlags.length === 0) return existing;
  const kept = (existing ?? "")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .filter((part) => !part.startsWith("--max-old-space-size") && !part.startsWith("--max-semi-space-size"));
  return [...kept, ...heapFlags].join(" ");
}

/**
 * 从 host 的崩溃信息判断是不是"堆爆了"。
 *
 * V8 OOM 有两种表现：
 *   1. `uncaughtException` 带 `JavaScript heap out of memory`（FatalProcessOutOfMemory）；
 *   2. 进程被信号打死（SIGABRT / exit 134），stderr 里有 `FATAL ERROR: ... heap limit`。
 */
export function isHeapExhaustion(input: { message?: string | null; exitCode?: number | null; signal?: string | null }): boolean {
  const message = (input.message ?? "").toLowerCase();
  if (message.includes("heap out of memory") || message.includes("allocation failed")) return true;
  if (message.includes("fatal error") && message.includes("heap")) return true;
  if (input.exitCode === 134) return true;
  if (input.signal === "SIGABRT") return true;
  return false;
}
