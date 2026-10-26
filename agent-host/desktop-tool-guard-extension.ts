/**
 * 工具调用护栏（P0）：给 shell 类工具补**默认超时 + 上限封顶**，并在单批并行过多时给一次低成本提醒。
 *
 * 为什么需要：
 *   1. pi 的 bash/powershell 的 `timeout` 是「可选、无默认值」——模型不传就永不超时。
 *      实测过 25 个调用并行、其中一个长驻调用（拉起 Host / measure 脚本）把整批挂到 300s 才出错。
 *   2. 超时是 pi 原生能力（超时后 `killProcessTree`），这里只改 `event.input.timeout`，
 *      不新造进程管理层、不装 watchdog。
 *
 * 原则（不降质的边界）：
 *   - **只补参数，不改结果**：正常返回的正文一个字都不动；
 *   - **绝不阻塞调用**：并行过多时只在结果尾部追加一句提醒，不 block、不丢工作；
 *   - **错误永不改写**：仅当错误本身就是 `timeout:<秒>` 时追加一句「怎么改」，原有正文完整保留；
 *   - codemode 脚本内的嵌套调用（`parentToolCallId` 非空）正是鼓励的路径，不计入并行数。
 *
 * 开关：`PIFORGE_TOOL_GUARD=0` 整体关闭（A/B 实测用）。
 */
import type {
  ExtensionAPI,
  ExtensionFactory,
  InlineExtension,
} from "./sdk-adapter.ts";

const SHELL_TOOL_NAMES: readonly string[] = ["bash", "powershell"];

export interface ToolGuardConfig {
  enabled: boolean;
  /** 普通命令默认超时（秒）。 */
  defaultSeconds: number;
  /** 普通命令上限（秒）。 */
  maxSeconds: number;
  /** 重型命令（编译 / 测试 / 打包 / 长驻脚本）默认与上限（秒）。 */
  heavySeconds: number;
  /** 单批并行调用数超过这个值时，追加一次提醒。 */
  maxParallel: number;
}

export const DEFAULT_TOOL_GUARD: ToolGuardConfig = {
  enabled: true,
  defaultSeconds: 45,
  maxSeconds: 300,
  heavySeconds: 300,
  maxParallel: 12,
};

/**
 * 重型命令：默认给更长的超时，否则真会误杀（`npm run dist` / 全量测试经常 >120s）。
 * 注意这是「给够时间」，不是「允许无限」——仍然有 heavySeconds 封顶。
 */
const HEAVY_PATTERNS: readonly RegExp[] = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|pack|dist|lint|smoke|dev)/i,
  /\b(?:npm|pnpm|yarn)\s+(?:ci|install|i)\b/i,
  /\bnode\s+(?:scripts|agent-host|electron)\//i,
  /\b(?:tsc|vitest|jest|electron-builder|playwright)\b/i,
  /\bgit\s+(?:clone|fetch|push|pull|gc|checkout)\b/i,
];

export function isHeavyCommand(command: string): boolean {
  return HEAVY_PATTERNS.some((pattern) => pattern.test(command));
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function resolveToolGuard(env: Record<string, string | undefined> = process.env): ToolGuardConfig {
  return {
    enabled: env.PIFORGE_TOOL_GUARD !== "0",
    defaultSeconds: positiveNumber(env.PIFORGE_TOOL_TIMEOUT_SECONDS, DEFAULT_TOOL_GUARD.defaultSeconds),
    maxSeconds: positiveNumber(env.PIFORGE_TOOL_TIMEOUT_MAX_SECONDS, DEFAULT_TOOL_GUARD.maxSeconds),
    heavySeconds: positiveNumber(env.PIFORGE_TOOL_TIMEOUT_HEAVY_SECONDS, DEFAULT_TOOL_GUARD.heavySeconds),
    maxParallel: positiveNumber(env.PIFORGE_TOOL_MAX_PARALLEL, DEFAULT_TOOL_GUARD.maxParallel),
  };
}

export type TimeoutAction = "kept" | "defaulted" | "clamped" | "repaired";

export interface TimeoutOutcome {
  seconds: number;
  action: TimeoutAction;
}

/**
 * 纯函数：就地改 `input.timeout`（pi 的 schema 字段，单位秒），返回实际生效值。
 * `input` 里没有 `command` 时按普通命令处理。
 */
export function guardShellTimeout(
  input: Record<string, unknown>,
  config: ToolGuardConfig = DEFAULT_TOOL_GUARD,
): TimeoutOutcome | null {
  const command = typeof input.command === "string" ? input.command : "";
  const heavy = isHeavyCommand(command);
  const cap = heavy
    ? Math.max(config.heavySeconds, config.maxSeconds)
    : Math.max(config.maxSeconds, config.defaultSeconds);
  const preferred = Math.min(
    heavy ? Math.max(config.heavySeconds, config.defaultSeconds) : config.defaultSeconds,
    cap,
  );

  const raw = input.timeout;
  if (raw === undefined || raw === null) {
    input.timeout = preferred;
    return { seconds: preferred, action: "defaulted" };
  }
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    // 模型偶尔传 "300" / NaN / 0：修成可用值，而不是让 pi 抛 "Invalid timeout"。
    input.timeout = preferred;
    return { seconds: preferred, action: "repaired" };
  }
  if (raw > cap) {
    input.timeout = cap;
    return { seconds: cap, action: "clamped" };
  }
  return { seconds: raw, action: "kept" };
}

/** 只在超时错误之后追加的一句改法（正文照旧在前面）。 */
export const TIMEOUT_HINT =
  "[tool-guard] 已到超时上限并终止进程树。改法：① 拆成小段、每段自带 timeout；② 长驻任务改用受管后台进程；③ 只要摘要时给脚本加 --summary，别整篇回放。";

export function isTimeoutError(text: string): boolean {
  return /\btimeout:\s*\d+/i.test(text);
}

export function isShellTool(toolName: string): boolean {
  return SHELL_TOOL_NAMES.includes(toolName);
}

/** 单批并行过多时的一次性提醒（每批最多一条，避免 25 条重复提示）。 */
export function parallelAdvisory(parallel: number, maxParallel: number): string {
  return (
    `[tool-guard] 本批并行 ${parallel} 个调用（建议 ≤${maxParallel}）。` +
    "超过这个数量后总耗时由最慢那条决定，且 Windows 下并发 fork 会互相抢管道。" +
    "后续请把独立读取合并进一次 codemode 脚本，重型命令单独跑。"
  );
}

/**
 * 每个用户轮的工具调用预算是**批次口径**：单批并行 ≤12，2–3 批是普通改动的正常量，
 * 所以硬顶放到 24（≈2 个满载批次），第 12 次（≈1 批满载）要求自检。
 * 只统计顶层调用（codemode 脚本内的嵌套调用不重复计），与并行计数口径一致。
 */
export const TURN_BUDGET = { softLimit: 12, hardLimit: 24 } as const;

export const TURN_SELF_CHECK_HINT =
  "[tool-guard] 本轮已用 12/24 次调用（约一个满载批次）—— 批后自检：现有输出是否已经够直接交付？" +
  "够就停手写结论，不要再补探针；不够就把剩余工作并成一批发完。";

export const TURN_BUDGET_EXHAUSTED_HINT =
  "[tool-guard] 本轮 24 次调用已用完（约两个满载批次）：停止新的探测，先交付可验证的结论与剩余待办，留给下一轮继续。";

/** 每用户轮计数：`use` 返回该次调用结束后应追加的提醒，`reset` 在新用户轮开始时调用。 */
export function createTurnBudgetTracker(
  softLimit: number = TURN_BUDGET.softLimit,
  hardLimit: number = TURN_BUDGET.hardLimit,
) {
  let used = 0;
  return {
    use(nested: boolean): string | undefined {
      if (nested) return undefined;
      used += 1;
      if (used === softLimit) return TURN_SELF_CHECK_HINT;
      if (used >= hardLimit) return TURN_BUDGET_EXHAUSTED_HINT;
      return undefined;
    },
    reset(): void {
      used = 0;
    },
    get used(): number {
      return used;
    },
  };
}

export interface ToolGuardStats {
  defaulted: number;
  clamped: number;
  repaired: number;
  advisories: number;
  timeoutHints: number;
  peakParallel: number;
  turnSelfChecks: number;
  turnBudgetHits: number;
}

export function emptyToolGuardStats(): ToolGuardStats {
  return {
    defaulted: 0,
    clamped: 0,
    repaired: 0,
    advisories: 0,
    timeoutHints: 0,
    peakParallel: 0,
    turnSelfChecks: 0,
    turnBudgetHits: 0,
  };
}

/**
 * 单批并行计数：`begin` 返回提醒文案（仅第一次超限时），`end` 在批次清空时复位。
 * 嵌套调用（codemode 脚本内）不计入。
 */
export function createParallelTracker(maxParallel: number) {
  const inFlight = new Set<string>();
  let advisorySent = false;
  let peak = 0;

  return {
    begin(toolCallId: string, nested: boolean): string | undefined {
      if (nested) return undefined;
      inFlight.add(toolCallId);
      if (inFlight.size > peak) peak = inFlight.size;
      if (inFlight.size > maxParallel && !advisorySent) {
        advisorySent = true;
        return parallelAdvisory(inFlight.size, maxParallel);
      }
      return undefined;
    },
    end(toolCallId: string): void {
      inFlight.delete(toolCallId);
      if (inFlight.size === 0) advisorySent = false;
    },
    get peakParallel(): number {
      return peak;
    },
    get size(): number {
      return inFlight.size;
    },
  };
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && typeof block === "object" && "text" in block ? String(block.text) : ""))
    .join("");
}

export interface DesktopToolGuardOptions {
  /** 运行期开关（设置页可关）；与 env 开关取与。 */
  enabled?: () => boolean;
  env?: Record<string, string | undefined>;
}

export function createDesktopToolGuardFactory(
  options: DesktopToolGuardOptions = {},
): ExtensionFactory {
  const config = resolveToolGuard(options.env ?? process.env);
  const isEnabled = () => config.enabled && (options.enabled ? options.enabled() : true);

  return (pi: ExtensionAPI) => {
    const tracker = createParallelTracker(config.maxParallel);
    const turnBudget = createTurnBudgetTracker();
    const stats = emptyToolGuardStats();
    /** toolCallId → 待追加到该条结果尾部的提示（并行提醒 / 轮预算提醒）。 */
    const pendingAdvisory = new Map<string, string[]>();

    const appendAdvisory = (toolCallId: string, text: string): void => {
      const list = pendingAdvisory.get(toolCallId);
      if (list) list.push(text);
      else pendingAdvisory.set(toolCallId, [text]);
    };

    // 每用户轮开始复位预算计数；工具结果触发的继续循环不会重置。
    pi.on("before_agent_start", () => {
      turnBudget.reset();
    });

    pi.on("tool_call", (event) => {
      if (!isEnabled()) return;

      if (isShellTool(event.toolName)) {
        const outcome = guardShellTimeout(event.input as Record<string, unknown>, config);
        if (outcome?.action === "defaulted") stats.defaulted += 1;
        else if (outcome?.action === "clamped") stats.clamped += 1;
        else if (outcome?.action === "repaired") stats.repaired += 1;
      }

      const budgetHint = turnBudget.use(Boolean(event.parentToolCallId));
      if (budgetHint) {
        appendAdvisory(event.toolCallId, budgetHint);
        if (budgetHint === TURN_SELF_CHECK_HINT) stats.turnSelfChecks += 1;
        else stats.turnBudgetHits += 1;
      }

      const advisory = tracker.begin(event.toolCallId, Boolean(event.parentToolCallId));
      if (advisory) {
        appendAdvisory(event.toolCallId, advisory);
        stats.advisories += 1;
      }
    });

    pi.on("tool_result", (event) => {
      tracker.end(event.toolCallId);
      if (tracker.peakParallel > stats.peakParallel) stats.peakParallel = tracker.peakParallel;
      if (!isEnabled()) return;

      const extra: string[] = [];
      const advisories = pendingAdvisory.get(event.toolCallId);
      if (advisories) {
        pendingAdvisory.delete(event.toolCallId);
        extra.push(...advisories);
      }
      if (event.isError && isTimeoutError(textOf(event.content))) {
        extra.push(TIMEOUT_HINT);
        stats.timeoutHints += 1;
      }
      if (extra.length === 0) return;
      return {
        content: [...event.content, { type: "text" as const, text: extra.join("\n\n") }],
      };
    });

    pi.on("session_shutdown", () => {
      if (process.env.PIFORGE_DEBUG_TOOL_GUARD === "1") {
        console.log("[tool-guard]", stats);
      }
    });
  };
}

export function desktopToolGuardInlineExtension(
  options: DesktopToolGuardOptions = {},
): InlineExtension {
  return {
    name: "desktop-tool-guard",
    factory: createDesktopToolGuardFactory(options),
  };
}
