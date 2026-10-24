/**
 * 一次性补写「推荐 pi 设置」——**只在键缺失时写**，永不覆盖用户手改值。
 *
 * 为什么改 pi 的 `settings.json` 而不是再造一份桌面设置：
 *   `defaultThinkingLevel` 已经是 pi 的一等设置，桌面「常规设置 · 默认思考等级」
 *   读写的也是它（`app/api/settings`）。再开一个 desktop-settings 副本，就会出现
 *   「面板显示 medium、实际按 low 跑」的双源问题。写一次、面板里可见、用户随时改回来，
 *   是唯一不会自相矛盾的做法。
 *
 * 只补思考预算这一项，**不写 `thinkingBudgets`**：pi 的默认 low 预算本来就是 2048
 * （`@earendil-works/pi-ai` DEFAULT_THINKING_BUDGETS），显式写一遍是零收益的全局副作用。
 * codemode 的呈现模式走 `createCodemodeExtension({ mode })` 的进程内覆盖，
 * 同样不需要污染全局 settings.json。
 *
 * 解析失败 / 非对象内容一律放弃（宁可不写，也不要把用户配置写坏）。
 */
import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { writeFileAtomic } from "../lib/atomic-write.ts";

/** 推荐值：新会话默认 low（≈2048 thinking 预算），桌面设置里可随时改回 medium/high。 */
export const RECOMMENDED_DEFAULT_THINKING_LEVEL = "low";

export interface RecommendedSettingsResult {
  /** 实际写入的键（空数组 = 已经有值，什么都没动）。 */
  written: string[];
  /** 未写入的原因，用于日志与排障。 */
  skipped?: "exists" | "unreadable" | "not-an-object" | "write-failed";
}

/**
 * 只补缺失键，返回实际改动，便于启动日志与单测断言。
 * 不抛异常：设置补写失败必须不影响 Host 启动。
 */
export function ensureRecommendedPiSettings(agentDir: string): RecommendedSettingsResult {
  const path = join(agentDir, "settings.json");
  let data: Record<string, unknown> = {};
  if (existsSync(path)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      return { written: [], skipped: "unreadable" };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { written: [], skipped: "not-an-object" };
    }
    data = parsed as Record<string, unknown>;
  }
  if (data.defaultThinkingLevel !== undefined) return { written: [], skipped: "exists" };

  const next = { ...data, defaultThinkingLevel: RECOMMENDED_DEFAULT_THINKING_LEVEL };
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    return { written: [], skipped: "write-failed" };
  }
  return { written: ["defaultThinkingLevel"] };
}
