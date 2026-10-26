/**
 * 「计费 tokens」口径：把一次请求的花费折算成**未缓存输入 token** 的等价量。
 *
 * 背景：界面上原来并列两行「本次新增」与「本轮对话新增」，主行显示的是
 * `input + output`（不含缓存读写）。同一份上下文在后续请求里全走缓存，token
 * 数与金额就永久脱钩，用户拿两行相除会得到「差 9 倍」这种无法解释的数字。
 *
 * 这里换成唯一口径：
 *   unit  = 该请求的未缓存输入单价（cost.input ÷ usage.input）
 *   计费tokens = cost.total ÷ unit
 * 缓存读 / 缓存写 / 输出都按各自单价折进同一个量纲，于是
 * **计费tokens × 未缓存输入单价 = 费用**，两行相除就只剩请求次数的倍数。
 *
 * 兼容性：`usage.cost` 是 pi 按模型定义算好的（含分档与缓存单价），这里不引入
 * 额外的价格表，也不会被汇率/币种影响——同一模型内单价恒定，折算天然自洽。
 */
import type { AssistantMessage } from "./types";

type Usage = NonNullable<AssistantMessage["usage"]>;

/** 该请求的未缓存输入单价（金额 / token）；`usage.input` 为 0 或免费模型返回 null。 */
export function inputUnitPrice(usage: Usage | null | undefined): number | null {
  if (!usage) return null;
  const input = usage.input ?? 0;
  const costInput = usage.cost?.input ?? 0;
  if (!(input > 0) || !(costInput > 0)) return null;
  const unit = costInput / input;
  return Number.isFinite(unit) && unit > 0 ? unit : null;
}

/**
 * 计费 tokens（未缓存输入等价量）。
 *
 * @param fallbackUnit 该请求全走缓存（`input === 0`）时退回同轮其它请求的单价；
 *   同模型同档位下这个单价是恒定的，所以不会把口径拉歪。
 */
export function billableTokens(
  usage: Usage | null | undefined,
  fallbackUnit?: number | null,
): number | null {
  if (!usage) return null;
  const total = usage.cost?.total ?? 0;
  if (!(total > 0)) return null;
  const unit = inputUnitPrice(usage) ?? (fallbackUnit && fallbackUnit > 0 ? fallbackUnit : null);
  if (!unit) return null;
  const tokens = total / unit;
  return Number.isFinite(tokens) && tokens > 0 ? tokens : null;
}
