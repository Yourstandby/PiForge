/**
 * Inline pi extension: 历史滑动窗口 + 结构化摘要（第三维度）。
 *
 * 两条路径共用同一份摘要逻辑：
 *   1. `agent_settled`：每轮结束后检查「窗口满 / 预算超限」双条件，满足就
 *      主动调 `ctx.compact()`（只触发一次，压完窗口自然回落）；
 *   2. `session_before_compact`：不论是手动 `/compact`、阈值触发还是溢出兜底，
 *      都由我们接管——切点按「最近 N 轮」对齐，摘要按四段结构生成。
 *
 * 任何一步失败都**不阻断**压缩：返回 undefined 让 pi 用它自己的摘要器。
 * 宁可摘要难看，也不能让用户的会话压不了。
 */
import type { ExtensionAPI, ExtensionFactory, InlineExtension } from "./sdk-adapter.ts";
import { contentToText } from "./ltm/observe-hooks.ts";
import {
  CONTEXT_BUDGET_RATIO,
  KEEP_RECENT_ROUNDS,
  MIN_DROPPABLE_TOKENS,
  MIN_ROUNDS_TO_DROP,
  assembleCompactionSummary,
  compactionSummaryInstructions,
  decideCompaction,
  estimateMessagesTokens,
  extractFilePaths,
  planCompactionCut,
  readRoundWindow,
  resolveContextCeiling,
  serializeMessagesForSummary,
  type MessageLike,
  type SessionEntryLike,
} from "./compaction-plan.ts";

/** 摘要调用的模型 / 运行时（复用当前会话的凭证与路由）。 */
export interface CompactionModelTarget {
  model?: unknown;
  modelRuntime?: { complete?: (...args: unknown[]) => Promise<unknown> } | undefined;
}

export interface HistoryCompactionOptions {
  /** 当前分支条目（sessionManager.getBranch()）。 */
  getEntries: () => readonly SessionEntryLike[] | undefined;
  /** 摘要用模型；缺失时回落到 pi 默认摘要。 */
  getTarget?: () => CompactionModelTarget | undefined;
  /** 保留最近多少轮。 */
  keepRounds?: number;
  minDropRounds?: number;
  budgetRatio?: number;
  /** 上下文硬顶（不传则按 `min(120k, 窗口 × 0.8)` 现算）。 */
  maxContextTokens?: number;
  minDroppableTokens?: number;
  /** 测试注入：直接产出摘要正文（不传则真调模型）。 */
  summarize?: (input: {
    messages: readonly MessageLike[];
    previousSummary: string | null;
    instructions: string;
    signal?: AbortSignal;
  }) => Promise<string | null>;
  /** 观察日志（默认静默，debug 环境变量打开）。 */
  log?: (message: string, detail?: unknown) => void;
}

const SUMMARY_SYSTEM_PROMPT =
  "You compress earlier turns of a coding-assistant conversation into a compact context checkpoint. " +
  "Follow the requested section structure exactly. Output only the checkpoint, no preamble.";

/** 摘要输出上限：够写四段，又不会变成新的包袱。 */
const SUMMARY_MAX_TOKENS = 1_600;

/** 会话已存活时长（取最早一条带时间戳的条目）；拿不到就返回 undefined（保持旧行为）。 */
function sessionAgeOf(entries: readonly SessionEntryLike[]): number | undefined {
  let earliest = Number.POSITIVE_INFINITY;
  for (const entry of entries) {
    const raw = (entry as { timestamp?: unknown }).timestamp;
    const parsed = typeof raw === "string" ? Date.parse(raw) : typeof raw === "number" ? raw : Number.NaN;
    if (Number.isFinite(parsed) && parsed < earliest) earliest = parsed;
  }
  if (!Number.isFinite(earliest)) return undefined;
  return Math.max(0, Date.now() - earliest);
}

function entriesToMessages(entries: readonly SessionEntryLike[], cut: { from: number; to: number }): MessageLike[] {
  const messages: MessageLike[] = [];
  for (let index = cut.from; index < cut.to; index += 1) {
    const entry = entries[index];
    if (entry?.type === "message" && entry.message && entry.message.role !== "system") {
      messages.push(entry.message);
    }
  }
  return messages;
}

async function defaultSummarize(
  target: CompactionModelTarget | undefined,
  input: {
    messages: readonly MessageLike[];
    previousSummary: string | null;
    instructions: string;
    signal?: AbortSignal;
  },
): Promise<string | null> {
  const model = target?.model;
  const runtime = target?.modelRuntime;
  if (!model || typeof runtime?.complete !== "function") return null;
  const conversation = serializeMessagesForSummary(input.messages);
  if (!conversation.trim()) return null;
  const prompt = [
    "<conversation>",
    conversation,
    "</conversation>",
    input.previousSummary
      ? `<previous-summary>\n${input.previousSummary.slice(0, 4_000)}\n</previous-summary>`
      : "",
    input.instructions,
  ]
    .filter(Boolean)
    .join("\n\n");
  const context = {
    systemPrompt: SUMMARY_SYSTEM_PROMPT,
    messages: [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: prompt }],
        timestamp: Date.now(),
      },
    ],
  };
  try {
    const result = (await runtime.complete(model, context, {
      maxTokens: SUMMARY_MAX_TOKENS,
      temperature: 0,
      // 用户按 Esc 中止压缩时，摘要调用也一起取消（别白烧 token）。
      ...(input.signal ? { signal: input.signal } : {}),
    })) as { content?: unknown } | undefined;
    const text = contentToText(result?.content).trim();
    return text || null;
  } catch {
    // 模型调用失败（限流 / 认证 / 断流）：回落到上一次摘要或确定性检查点，
    // 绝不阻断压缩流程。
    return null;
  }
}

export function createDesktopCompactionFactory(options: HistoryCompactionOptions): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    const keepRounds = options.keepRounds ?? KEEP_RECENT_ROUNDS;
    const log = options.log ?? (() => {});
    const summarize = options.summarize ?? ((input) => defaultSummarize(options.getTarget?.(), input));
    /** 防止 `agent_settled` 在压缩完成前重复触发。 */
    let pendingCompaction = false;
    /** 上一次触发时的轮数：同轮数不重复触发（onComplete 可能不回调）。 */
    let lastTriggeredRounds = -1;

    pi.on("session_before_compact", async (event) => {
      const entries = (event.branchEntries ?? options.getEntries?.() ?? []) as readonly SessionEntryLike[];
      // 切点优先用 pi 算好的 preparation：它按 `keepRecentTokens` 在条目边界上取切点，
      // 还能处理「一轮超预算被切开」的 turnPrefix（PiForge 的轮对齐逻辑没这能力）。
      // 只有拿不到 preparation 时才回退到自己的轮回切点。
      const preparation = event.preparation;
      /** 只有当 pi 真的给了切点与消息时才用它（测试/老版本可能只带 tokensBefore）。 */
      const usablePreparation =
        preparation &&
        Array.isArray(preparation.messagesToSummarize) &&
        typeof preparation.firstKeptEntryId === "string" &&
        preparation.firstKeptEntryId.length > 0
          ? preparation
          : undefined;
      const planned = usablePreparation ? null : planCompactionCut(entries, keepRounds);
      if (!usablePreparation && !planned) {
        log("[compaction] no round-aligned cut, falling back to pi", { keepRounds });
        return;
      }
      const messages: readonly MessageLike[] = usablePreparation
        ? [
            ...(usablePreparation.messagesToSummarize as readonly MessageLike[]),
            ...((usablePreparation.turnPrefixMessages ?? []) as readonly MessageLike[]),
          ]
        : entriesToMessages(entries, planned!);
      const firstKeptEntryId = usablePreparation?.firstKeptEntryId ?? planned!.firstKeptEntryId;
      const previousSummary = usablePreparation
        ? (usablePreparation.previousSummary ?? null)
        : planned!.previousSummary;
      const raw = await summarize({
        messages,
        previousSummary,
        instructions: compactionSummaryInstructions(),
        signal: event.signal,
      });
      const filePaths = extractFilePaths(messages);
      const assembled = assembleCompactionSummary(raw, {
        modifiedFiles: filePaths.modifiedFiles,
        readFiles: filePaths.readFiles,
        previousSummary,
      });
      log("[compaction] structured summary", {
        reason: event.reason,
        source: usablePreparation ? "pi-cut" : "round-cut",
        messages: messages.length,
        chars: assembled.summary.length,
        fallback: assembled.fallback,
      });
      return {
        compaction: {
          summary: assembled.summary,
          firstKeptEntryId,
          tokensBefore: event.preparation?.tokensBefore ?? 0,
          details: {
            readFiles: filePaths.readFiles,
            modifiedFiles: filePaths.modifiedFiles,
          },
        },
      };
    });

    pi.on("agent_settled", async (event, ctx) => {
      if (event.aborted) return;
      if (pendingCompaction) return;
      if (typeof ctx.isIdle === "function" && !ctx.isIdle()) return;

      const entries = (options.getEntries?.() ??
        (ctx.sessionManager?.getBranch?.() as readonly SessionEntryLike[] | undefined) ??
        []) as readonly SessionEntryLike[];
      const window = readRoundWindow(entries);
      /** 先算出切点，顺带拿到「被压区间有多大」：太小就不值得压。 */
      const cut = planCompactionCut(entries, keepRounds);
      const usage = ctx.getContextUsage?.();
      const decision = decideCompaction({
        rounds: window.roundStarts.length,
        tokens: usage?.tokens ?? null,
        contextWindow: usage?.contextWindow ?? 0,
        // 短会话（<2h）不主动压窗口：保留服务端 prompt cache 的命中率。
        sessionAgeMs: sessionAgeOf(entries),
        droppableTokens: cut ? estimateMessagesTokens(cut.messages) : 0,
        keepRounds,
        minDropRounds: options.minDropRounds ?? MIN_ROUNDS_TO_DROP,
        budgetRatio: options.budgetRatio ?? CONTEXT_BUDGET_RATIO,
        maxContextTokens: options.maxContextTokens ?? resolveContextCeiling(usage?.contextWindow ?? 0),
        minDroppableTokens: options.minDroppableTokens ?? MIN_DROPPABLE_TOKENS,
      });
      if (!decision.trigger) return;
      // 同轮数不重复触发（onComplete 可能不回调）；但**越过硬顶**时必须允许重试，
      // 否则一次失败就把会话钉死在超限状态里（读数一直红着压不下去）。
      if (decision.reason !== "ceiling" && window.roundStarts.length === lastTriggeredRounds) return;

      lastTriggeredRounds = window.roundStarts.length;
      pendingCompaction = true;
      log("[compaction] trigger", {
        reason: decision.reason,
        rounds: window.roundStarts.length,
        droppable: decision.droppableRounds,
        droppableTokens: decision.droppableTokens,
        tokens: decision.tokens,
        contextWindow: decision.contextWindow,
      });
      ctx.compact({
        customInstructions: compactionSummaryInstructions(),
        onComplete: () => {
          pendingCompaction = false;
        },
        onError: (error) => {
          pendingCompaction = false;
          log("[compaction] failed", { error: error.message });
        },
      });
    });
  };
}

export function desktopCompactionInlineExtension(options: HistoryCompactionOptions): InlineExtension {
  return {
    name: "desktop-compaction",
    factory: createDesktopCompactionFactory(options),
  };
}
