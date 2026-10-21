/**
 * 思考强度（reasoning effort）菜单的选项。
 *
 * 只保留三档，对应后端枚举：
 *   auto   → "auto"    沿用 Pi 默认
 *   均衡   → "medium"  medium reasoning
 *   高质量 → "high"    高推理强度（模型支持时 pi 会自动收敛到合法值）
 *
 * Pi 后端仍然接受完整枚举（off / minimal / low / high / xhigh / max），
 * 因此这里**不裁剪枚举本身**：老会话持久化的 low / xhigh 等值仍能正常回显
 * （由 StatusBar 的 THINKING_LABELS 渲染），只是菜单里不再提供入口。
 */
export const THINKING_LEVELS = ["auto", "medium", "high"] as const;

export type CuratedThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * 按模型能力过滤：auto 永远可选；均衡 / 高质量需要模型支持对应的枚举值。
 * `available` 为 null 表示未知（或未加载），此时全部展示。
 */
export function getThinkingLevelsForModel(
  available: readonly string[] | null | undefined,
): CuratedThinkingLevel[] {
  return THINKING_LEVELS.filter((level) => {
    if (!available) return true;
    if (level === "auto") return true;
    return available.includes(level);
  });
}
