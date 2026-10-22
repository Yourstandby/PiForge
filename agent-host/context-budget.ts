/**
 * 上下文预算（第四维度：让用户看见「离硬顶还有多远」）。
 *
 * 日志里的 cacheRead ≈ 117k–121k 说明主要成本是每轮重放历史，但 UI 只显示
 * tokens/s 和本轮产出，用户看不出上下文已经贴到硬顶。这里把用量换算成
 * **相对硬顶**的进度和等级，前端只负责上色，不再各自猜阈值。
 *
 * 纯函数：不读文件、不依赖 SDK，方便直接单测。
 */
import type { ContextBudget } from "../lib/pi-types.ts";
import { MAX_CONTEXT_TOKENS } from "./compaction-plan.ts";

/** 单一真相：硬顶常量只在 compaction-plan 定义，这里只做展示换算。 */
export const DEFAULT_MAX_CONTEXT_TOKENS = MAX_CONTEXT_TOKENS;

/** 到达硬顶的这个比例就必须提醒，再涨一轮就会触发压缩。 */
const CRITICAL_RATIO = 0.85;
/** 进入观察区的比例：还不会压，但成本已经开始明显。 */
const WARN_RATIO = 0.6;

function normalizeCeiling(maxContextTokens: number | undefined): number {
  if (
    typeof maxContextTokens === "number" &&
    Number.isFinite(maxContextTokens) &&
    maxContextTokens > 0
  ) {
    return Math.round(maxContextTokens);
  }
  return DEFAULT_MAX_CONTEXT_TOKENS;
}

function budgetHint(input: {
  tokens: number | null;
  ceiling: number;
  ratioToCeiling: number;
  level: ContextBudget["level"];
}): string {
  if (input.tokens === null) {
    return "还没统计到这段对话占用的记忆，超上限时会自动压缩";
  }
  const percent = Math.round(input.ratioToCeiling * 100);
  if (input.ratioToCeiling >= 1) {
    return "这段对话的记忆已经装不下了，这一轮结束就把旧内容压缩掉";
  }
  if (input.level === "critical") {
    return `这段对话的记忆快满了（${percent}%），下一轮就会自动压缩旧内容`;
  }
  if (input.level === "warn") {
    return `这段对话的记忆用了 ${percent}%，再聊几轮就会自动压缩`;
  }
  return `这段对话的记忆用了 ${percent}%，还很宽裕`;
}

/**
 * 把一次 `getContextUsage()` 的读数换算成预算视图。
 * `tokens` 为 null 表示还没拿到 usage：等级保持 "ok"，但 hint 明确说「未知」，
 * 避免前端把 0 当成真实占用。
 */
export function describeContextBudget(input: {
  tokens: number | null;
  contextWindow: number;
  maxContextTokens?: number;
}): ContextBudget {
  const ceiling = normalizeCeiling(input.maxContextTokens);
  const tokens =
    input.tokens === null || !Number.isFinite(input.tokens)
      ? null
      : Math.max(0, Math.round(input.tokens));
  const ratioToCeiling = tokens === null ? 0 : tokens / ceiling;
  const ratioToWindow =
    tokens === null || !(input.contextWindow > 0) ? 0 : tokens / input.contextWindow;
  const level: ContextBudget["level"] =
    tokens === null
      ? "ok"
      : ratioToCeiling >= CRITICAL_RATIO
        ? "critical"
        : ratioToCeiling >= WARN_RATIO
          ? "warn"
          : "ok";

  return {
    tokens,
    ceiling,
    ratioToCeiling,
    ratioToWindow,
    level,
    overshoot: ratioToCeiling >= 1,
    hint: budgetHint({ tokens, ceiling, ratioToCeiling, level }),
  };
}
