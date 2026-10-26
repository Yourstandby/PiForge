import type { AgentMessage, AssistantMessage } from "../../lib/types";

/**
 * 模型计价方案（per-model pricing）
 *
 * pi 的 usage.cost.* 只有数字、不带币种：数字的语义完全取决于模型定义里
 * cost 的单位。内置模型目录按「USD / 百万 tokens」标注，但自定义 provider 与
 * 国内厂商的官方报价常常直接填人民币——界面若再乘一次汇率，金额会被放大
 * ~7 倍，看起来就像「token 数对不上价格」。所以币种必须跟着模型走：
 *
 *  - 未声明             → USD（保持历史行为，内置目录不受影响）
 *  - cost.currency=CNY  → 该模型的数字按人民币解释，显示时不再乘汇率
 *
 * 分档计价（cost.tiers：单次请求输入超过阈值后整单改用另一档单价）与缓存读写
 * 单价由 pi 的 calculateCost 负责；这里只做币种归类与分桶累加。
 */
export type CostCurrency = "USD" | "CNY";

export interface CostBuckets {
  usd: number;
  cny: number;
}

export function normalizeCurrency(value: unknown): CostCurrency {
  return typeof value === "string" && value.trim().toUpperCase() === "CNY" ? "CNY" : "USD";
}

let currencyByModel = new Map<string, CostCurrency>();

/** 注册 "provider/model" → 币种；由 /api/model-pricing 提供，未注册的按 USD 计。 */
export function registerModelCurrencies(map: Record<string, unknown> | null | undefined): void {
  const next = new Map<string, CostCurrency>();
  for (const [key, value] of Object.entries(map ?? {})) {
    const normalizedKey = key.trim().toLowerCase();
    if (normalizedKey) next.set(normalizedKey, normalizeCurrency(value));
  }
  currencyByModel = next;
}

export function modelCurrency(provider?: string | null, model?: string | null): CostCurrency {
  const key = (provider ?? "").trim().toLowerCase() + "/" + (model ?? "").trim();
  return currencyByModel.get(key) ?? "USD";
}

export function addCost(buckets: CostBuckets, amount: number, currency: CostCurrency): CostBuckets {
  if (!Number.isFinite(amount) || amount === 0) return buckets;
  return currency === "CNY"
    ? { usd: buckets.usd, cny: buckets.cny + amount }
    : { usd: buckets.usd + amount, cny: buckets.cny };
}

export interface SessionStats {
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    /** 思考/推理 tokens，是 output 的子集；仅提供商上报时存在。 */
    reasoning?: number;
    total?: number;
  };
  cacheHitRate?: number | null;
  /** 兼容旧字段：USD 桶与 CNY 桶数字之和（仅同币种时有意义）。 */
  cost?: number;
  /** 分币种累加：USD 桶按实盘汇率折算，CNY 桶原样显示，避免二次换算。 */
  costUsd?: number;
  costCny?: number;
}

/** 单个工具的调用汇总。 */
export interface ToolCallStat {
  name: string;
  count: number;
  errors: number;
}

/** 会话活动：回合数 + 工具调用分布（不依赖 token 用量，零用量时也有值）。 */
export interface SessionActivity {
  /** user 消息数，即对话回合数。 */
  turns: number;
  toolCalls: {
    total: number;
    byTool: ToolCallStat[];
  };
}

export const EMPTY_SESSION_ACTIVITY: SessionActivity = {
  turns: 0,
  toolCalls: { total: 0, byTool: [] },
};

export function calculateSessionStats(messages: AgentMessage[]): SessionStats | null {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let reasoning = 0;
  let costBuckets: CostBuckets = { usd: 0, cny: 0 };

  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const usage = (msg as AssistantMessage).usage;
    if (!usage) continue;
    tokens.input += usage.input ?? 0;
    tokens.output += usage.output ?? 0;
    tokens.cacheRead += usage.cacheRead ?? 0;
    tokens.cacheWrite += usage.cacheWrite ?? 0;
    reasoning += usage.reasoning ?? 0;
    costBuckets = addCost(
      costBuckets,
      usage.cost?.total ?? 0,
      usage.cost?.currency
        ? normalizeCurrency(usage.cost.currency)
        : modelCurrency((msg as AssistantMessage).provider, (msg as AssistantMessage).model),
    );
  }

  const total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  if (total === 0) return null;

  const promptTokens = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  const cacheHitRate = promptTokens > 0 ? (tokens.cacheRead / promptTokens) * 100 : undefined;

  return {
    tokens: { ...tokens, ...(reasoning > 0 ? { reasoning } : {}), total },
    cacheHitRate,
    cost: costBuckets.usd + costBuckets.cny,
    costUsd: costBuckets.usd,
    costCny: costBuckets.cny,
  };
}

/**
 * 统计会话活动：
 * - turns：一条 user 消息 = 一个回合（与终端 `N turns` 一致）
 * - toolCalls：统计 assistant 内容中的 toolCall 块，并用 toolResult.isError 标记失败次数
 * 与 token 用量无关，所以即使还没有 usage 数据也能展示。
 */
export function calculateSessionActivity(messages: AgentMessage[]): SessionActivity {
  let turns = 0;
  const byName = new Map<string, ToolCallStat>();

  const bump = (rawName: string | undefined) => {
    const name = rawName && rawName.trim() ? rawName : "unknown";
    const entry = byName.get(name) ?? { name, count: 0, errors: 0 };
    entry.count += 1;
    byName.set(name, entry);
    return entry;
  };

  for (const msg of messages) {
    if (msg.role === "user") {
      turns += 1;
      continue;
    }
    if (msg.role === "assistant") {
      const blocks = (msg as AssistantMessage).content;
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks) {
        if ((block as { type?: string }).type === "toolCall") {
          bump((block as { toolName?: string }).toolName);
        }
      }
      continue;
    }
    if (msg.role === "toolResult" && msg.isError && msg.toolName) {
      const entry = byName.get(msg.toolName);
      if (entry) entry.errors += 1;
    }
  }

  const byTool = Array.from(byName.values()).sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name),
  );
  return {
    turns,
    toolCalls: {
      total: byTool.reduce((sum, tool) => sum + tool.count, 0),
      byTool,
    },
  };
}
