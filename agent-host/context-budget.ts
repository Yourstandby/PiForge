/**
 * 上下文预算（第四维度：让用户看见「真实窗口还剩多少」）。
 *
 * 分母只有一个：模型自己报告的上下文窗口（`contextUsage.contextWindow`）。
 * 这里不再掺任何压缩硬顶 / 自适应阈值——压缩是否发生与「窗口装了多少」
 * 是两件事，混在一起会让 1M 窗口的模型在 16k 时就画成半个环。
 *
 * 阈值只决定颜色：60% 观察、85% 告警，环和文字共用同一份结果。
 *
 * 纯函数：不读文件、不依赖 SDK，方便直接单测。
 */
import type { ContextBudget } from "../lib/pi-types.ts";

/** 到达这个比例就变黄：还装得下，但成本已经明显。 */
const WARN_RATIO = 0.6;
/** 到达这个比例就变红：再长就要真的压了。 */
const CRITICAL_RATIO = 0.85;

/** 120_000 → "120k"；窗口取整，避免 "1.0M" 这种无信息的小数。 */
function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    const m = value / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (value >= 1_000) {
    const k = value / 1_000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }
  return String(value);
}

function normalizeCeiling(contextWindow: number | undefined): number {
  if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
    return Math.round(contextWindow);
  }
  return 0;
}

function budgetHint(input: {
  tokens: number | null;
  ceiling: number;
  ratio: number;
  level: ContextBudget["level"];
}): string {
  if (input.tokens === null) {
    return "还没统计到这段对话占用的 token";
  }
  if (input.ceiling <= 0) {
    return `已用 ${formatTokens(input.tokens)} token，当前模型没有报告上下文窗口，无法换算占比`;
  }
  const used = `${formatTokens(input.tokens)} / ${formatTokens(input.ceiling)} token`;
  const percent = (input.ratio * 100).toFixed(input.ratio < 0.1 ? 1 : 0);
  if (input.ratio >= 1) {
    return `${used}，已超出窗口，这一轮之后旧内容会被裁剪`;
  }
  if (input.level === "critical") {
    return `${used}（${percent}%），快装满了，建议先压缩再继续`;
  }
  if (input.level === "warn") {
    return `${used}（${percent}%），用过半了`;
  }
  return `${used}（${percent}%），还很宽裕`;
}

/**
 * 把一次 `getContextUsage()` 的读数换算成预算视图。
 * `tokens` 为 null 表示还没拿到 usage：等级保持 "ok"，但 hint 明确说「未知」，
 * 避免前端把 0 当成真实占用。
 */
export function describeContextBudget(input: {
  tokens: number | null;
  contextWindow: number;
}): ContextBudget {
  const ceiling = normalizeCeiling(input.contextWindow);
  const tokens =
    input.tokens === null || !Number.isFinite(input.tokens)
      ? null
      : Math.max(0, Math.round(input.tokens));
  const ratio = tokens === null || ceiling <= 0 ? 0 : tokens / ceiling;
  const level: ContextBudget["level"] =
    tokens === null || ceiling <= 0
      ? "ok"
      : ratio >= CRITICAL_RATIO
        ? "critical"
        : ratio >= WARN_RATIO
          ? "warn"
          : "ok";

  return {
    tokens,
    ceiling,
    ratioToCeiling: ratio,
    level,
    overshoot: ratio >= 1,
    hint: budgetHint({ tokens, ceiling, ratio, level }),
  };
}
