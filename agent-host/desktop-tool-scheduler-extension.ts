/**
 * 会话隔离调度器：把「一个会话刷 25 个并行工具」关进配额里，别拖慢同一 Host 进程里的其它会话。
 *
 * 为什么能在 `tool_call` 里排队：SDK 的 `emitToolCall` 逐个 `await` handler，而一批里的每个调用
 * 各自走一次 `_beforeToolCall`。所以 async handler 里 `await` 槽位 = 天然排队点：超额调用停在
 * 自己的钩子里，不 block、不丢结果，只是晚点执行。
 *
 * 两道闸叠加：
 *   - **全局**：保护 Host 的事件循环（Shell 输出要在这条 loop 上收、判截断、走 IPC）；
 *   - **单会话**：防一个会话把全局额度吃光（这就是「隔壁跑 25 个，我这卡」的正解）。
 *
 * 不降质的边界：
 *   - 只延后执行，不改参数、不改结果；排队超过 `queueHintMs` 才在结果尾部追加一句提示（复用 guard 的追加方式）；
 *   - `codemode` 与嵌套调用（`parentToolCallId` 非空）**豁免**：它们本身就是合并后的批量；
 *   - 等不到槽位时**放弃排队、照常执行**（宁可偶尔超发，也不能因为调度器把活卡死）。
 *
 * 开关：`PIFORGE_TOOL_SCHEDULER=0`。
 */
import type {
  ExtensionAPI,
  ExtensionFactory,
  InlineExtension,
} from "./sdk-adapter.ts";
import { isHeavyCommand } from "./desktop-tool-guard-extension.ts";

export type ToolTier = "heavy" | "light";

export interface SchedulerConfig {
  enabled: boolean;
  /** 全局同时执行的槽位数。 */
  globalHeavy: number;
  globalLight: number;
  /** 单个会话能同时占用的槽位数。 */
  sessionHeavy: number;
  sessionLight: number;
  /** 等槽位的上限（毫秒）；超过就放弃排队照常执行。 */
  maxWaitMs: number;
  /** 排队超过这个时长才追加提示（毫秒）。 */
  queueHintMs: number;
  /** 持槽上限：防止 approval block / 进程僵死导致槽位永久泄漏。 */
  maxHoldMs: number;
}

export const DEFAULT_SCHEDULER: SchedulerConfig = {
  enabled: true,
  globalHeavy: 6,
  globalLight: 12,
  sessionHeavy: 4,
  sessionLight: 6,
  maxWaitMs: 60_000,
  queueHintMs: 1_500,
  maxHoldMs: 15 * 60_000,
};

function positiveNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function resolveSchedulerConfig(
  env: Record<string, string | undefined> = process.env,
): SchedulerConfig {
  return {
    enabled: env.PIFORGE_TOOL_SCHEDULER !== "0",
    globalHeavy: positiveNumber(env.PIFORGE_SCHED_GLOBAL_HEAVY, DEFAULT_SCHEDULER.globalHeavy),
    globalLight: positiveNumber(env.PIFORGE_SCHED_GLOBAL_LIGHT, DEFAULT_SCHEDULER.globalLight),
    sessionHeavy: positiveNumber(env.PIFORGE_SCHED_SESSION_HEAVY, DEFAULT_SCHEDULER.sessionHeavy),
    sessionLight: positiveNumber(env.PIFORGE_SCHED_SESSION_LIGHT, DEFAULT_SCHEDULER.sessionLight),
    maxWaitMs: positiveNumber(env.PIFORGE_SCHED_MAX_WAIT_MS, DEFAULT_SCHEDULER.maxWaitMs),
    queueHintMs: positiveNumber(env.PIFORGE_SCHED_QUEUE_HINT_MS, DEFAULT_SCHEDULER.queueHintMs),
    maxHoldMs: positiveNumber(env.PIFORGE_SCHED_MAX_HOLD_MS, DEFAULT_SCHEDULER.maxHoldMs),
  };
}

/** 重型：真占 CPU / 磁盘的 shell 命令。其余 shell 归 light，非 shell 工具一律 light。 */
export function classifyTool(toolName: string, input: unknown): ToolTier {
  if (toolName !== "bash" && toolName !== "powershell") return "light";
  const command =
    input && typeof input === "object" && typeof (input as { command?: unknown }).command === "string"
      ? (input as { command: string }).command
      : "";
  return isHeavyCommand(command) ? "heavy" : "light";
}

/** codemode 与嵌套调用不走调度（它本身就是「合并后的一次批量」）。 */
export function isExemptTool(toolName: string, nested: boolean): boolean {
  if (nested) return true;
  return toolName === "codemode" || toolName === "tool_search" || toolName === "tool_history_get";
}

type Waiter = {
  cancelled: boolean;
  resolve: (granted: boolean) => void;
};

export interface Limiter {
  acquire(maxWaitMs: number): Promise<boolean>;
  release(): void;
  readonly active: number;
  readonly waiting: number;
}

export function createLimiter(limit: number): Limiter {
  let active = 0;
  const waiters: Waiter[] = [];

  const pump = () => {
    while (active < limit && waiters.length > 0) {
      const waiter = waiters.shift()!;
      if (waiter.cancelled) continue;
      active += 1;
      waiter.resolve(true);
    }
  };

  return {
    acquire(maxWaitMs: number): Promise<boolean> {
      if (active < limit) {
        active += 1;
        return Promise.resolve(true);
      }
      return new Promise<boolean>((resolve) => {
        const waiter: Waiter = { cancelled: false, resolve };
        waiters.push(waiter);
        if (Number.isFinite(maxWaitMs) && maxWaitMs > 0) {
          const timer = setTimeout(() => {
            waiter.cancelled = true;
            resolve(false);
          }, maxWaitMs);
          timer.unref?.();
        }
      });
    },
    release() {
      active = Math.max(0, active - 1);
      pump();
    },
    get active() {
      return active;
    },
    get waiting() {
      return waiters.filter((waiter) => !waiter.cancelled).length;
    },
  };
}

export interface Lease {
  /** 是否真的拿到了槽位（false = 放弃排队，照常执行）。 */
  granted: boolean;
  /** 等槽位耗时（毫秒）。 */
  waitedMs: number;
  tier: ToolTier;
}

export interface SchedulerStats {
  acquired: number;
  degraded: number;
  queued: number;
  releases: number;
  leaked: number;
  peakGlobal: number;
}

export interface Scheduler {
  acquire(input: {
    callId: string;
    sessionKey: string;
    tier: ToolTier;
  }): Promise<Lease>;
  release(callId: string): boolean;
  releaseSession(sessionKey: string): void;
  stats(): SchedulerStats;
}

export function createScheduler(config: SchedulerConfig = DEFAULT_SCHEDULER): Scheduler {
  const globalLimiter = {
    heavy: createLimiter(config.globalHeavy),
    light: createLimiter(config.globalLight),
  };
  const sessionLimiters = new Map<string, { heavy: Limiter; light: Limiter }>();
  const held = new Map<string, { sessionKey: string; tier: ToolTier; timer?: NodeJS.Timeout }>();
  const stats: SchedulerStats = {
    acquired: 0,
    degraded: 0,
    queued: 0,
    releases: 0,
    leaked: 0,
    peakGlobal: 0,
  };

  const limitersFor = (sessionKey: string) => {
    const existing = sessionLimiters.get(sessionKey);
    if (existing) return existing;
    const created = {
      heavy: createLimiter(config.sessionHeavy),
      light: createLimiter(config.sessionLight),
    };
    sessionLimiters.set(sessionKey, created);
    return created;
  };

  return {
    async acquire({ callId, sessionKey, tier }): Promise<Lease> {
      const startedAt = Date.now();
      const sessionLimiter = limitersFor(sessionKey)[tier];
      const global = globalLimiter[tier];

      const sessionOk = await sessionLimiter.acquire(config.maxWaitMs);
      if (!sessionOk) {
        stats.degraded += 1;
        return { granted: false, waitedMs: Date.now() - startedAt, tier };
      }
      const globalOk = await global.acquire(config.maxWaitMs);
      if (!globalOk) {
        sessionLimiter.release();
        stats.degraded += 1;
        return { granted: false, waitedMs: Date.now() - startedAt, tier };
      }

      const totalActive = globalLimiter.heavy.active + globalLimiter.light.active;
      if (totalActive > stats.peakGlobal) stats.peakGlobal = totalActive;
      stats.acquired += 1;

      const timer = setTimeout(() => {
        // 持槽超上限：强制回收，避免 approval block / 僵死调用把额度永久占住。
        if (held.delete(callId)) {
          limitersFor(sessionKey)[tier].release();
          globalLimiter[tier].release();
          stats.leaked += 1;
        }
      }, config.maxHoldMs);
      timer.unref?.();

      held.set(callId, { sessionKey, tier, timer });
      return { granted: true, waitedMs: Date.now() - startedAt, tier };
    },
    release(callId: string): boolean {
      const entry = held.get(callId);
      if (!entry) return false;
      held.delete(callId);
      if (entry.timer) clearTimeout(entry.timer);
      limitersFor(entry.sessionKey)[entry.tier].release();
      globalLimiter[entry.tier].release();
      stats.releases += 1;
      return true;
    },
    releaseSession(sessionKey: string): void {
      for (const [callId, entry] of [...held]) {
        if (entry.sessionKey === sessionKey) {
          held.delete(callId);
          if (entry.timer) clearTimeout(entry.timer);
          limitersFor(sessionKey)[entry.tier].release();
          globalLimiter[entry.tier].release();
        }
      }
      // 会话没了，等待队列里的条目靠各自的 maxWaitMs 自行超时（resolve(false) → 降级执行），
      // 这里不能主动 release：那会把槽位授给一个已经不存在的会话。
      sessionLimiters.delete(sessionKey);
    },
    stats(): SchedulerStats {
      return { ...stats };
    },
  };
}

/** 进程级共享实例：跨会话配额必须共用同一份计数。 */
let shared: Scheduler | null = null;

export function sharedScheduler(env: Record<string, string | undefined> = process.env): Scheduler {
  if (!shared) shared = createScheduler(resolveSchedulerConfig(env));
  return shared;
}

/** 测试用：丢弃共享实例。 */
export function resetSharedScheduler(): void {
  shared = null;
}

export function queueAdvisory(waitedMs: number, tier: ToolTier): string {
  const seconds = (waitedMs / 1000).toFixed(1);
  return (
    `[tool-scheduler] 该调用等了 ${seconds}s 才拿到执行槽位（${tier} 档）。` +
    "同批并行过多时总耗时由最慢一条决定：把独立读取合并进一次 codemode 脚本，重型命令单独跑。"
  );
}

export interface DesktopToolSchedulerOptions {
  /** 会话标识（跨会话配额的分组键），在执行时求值。 */
  getSessionKey: () => string;
  enabled?: () => boolean;
  scheduler?: Scheduler;
  config?: SchedulerConfig;
}

export function createDesktopToolSchedulerFactory(
  options: DesktopToolSchedulerOptions,
): ExtensionFactory {
  const config = options.config ?? resolveSchedulerConfig();
  const scheduler = options.scheduler ?? sharedScheduler();
  const isEnabled = () => config.enabled && (options.enabled ? options.enabled() : true);

  return (pi: ExtensionAPI) => {
    /** toolCallId → 排队提示（等 tool_result 时追加）。 */
    const hints = new Map<string, string>();
    /** 本会话里真正拿到槽位的调用（releaseSession 兜底用）。 */
    const granted = new Set<string>();

    pi.on("tool_call", async (event) => {
      if (!isEnabled()) return;
      if (isExemptTool(event.toolName, Boolean(event.parentToolCallId))) return;

      const tier = classifyTool(event.toolName, event.input);
      const lease = await scheduler.acquire({
        callId: event.toolCallId,
        sessionKey: options.getSessionKey(),
        tier,
      });
      if (!lease.granted) return;
      granted.add(event.toolCallId);
      if (lease.waitedMs >= config.queueHintMs) {
        hints.set(event.toolCallId, queueAdvisory(lease.waitedMs, lease.tier));
      }
    });

    pi.on("tool_result", (event) => {
      if (granted.delete(event.toolCallId)) scheduler.release(event.toolCallId);
      const hint = hints.get(event.toolCallId);
      if (!hint) return;
      hints.delete(event.toolCallId);
      return {
        content: [...event.content, { type: "text" as const, text: hint }],
      };
    });

    pi.on("session_shutdown", () => {
      const sessionKey = options.getSessionKey();
      scheduler.releaseSession(sessionKey);
      granted.clear();
      hints.clear();
      if (process.env.PIFORGE_DEBUG_TOOL_SCHEDULER === "1") {
        console.log("[tool-scheduler]", sessionKey, scheduler.stats());
      }
    });
  };
}

export function desktopToolSchedulerInlineExtension(
  options: DesktopToolSchedulerOptions,
): InlineExtension {
  return {
    name: "desktop-tool-scheduler",
    factory: createDesktopToolSchedulerFactory(options),
  };
}
