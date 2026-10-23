/**
 * 思考强度（reasoning effort）菜单的选项。
 *
 * 只保留四档，对应后端枚举：
 *   auto   → "auto"    沿用 Pi 默认
 *   高质量 → "high"    高推理强度（模型支持时 pi 会自动收敛到合法值）
 *   均衡   → "medium"  medium reasoning
 *   低质量 → "low"     低推理强度，省 token / 省时间
 *
 * Pi 后端仍然接受完整枚举（off / minimal / low / high / xhigh / max），
 * 因此这里**不裁剪枚举本身**：老会话持久化的 low / xhigh 等值仍能正常回显
 * （由 StatusBar 的 THINKING_LABELS 渲染），只是菜单里不再提供入口。
 */
export const THINKING_LEVELS = ["auto", "high", "medium", "low"] as const;

export type CuratedThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * 按模型能力过滤：available 明确为空数组（模型不提供任何 thinking 档位）时只给 auto；
 * 否则四档全部保留——后端会把不支持的档位自动收敛到合法值。
 */
export function getThinkingLevelsForModel(
  available: readonly string[] | null | undefined,
): CuratedThinkingLevel[] {
  if (available && available.length === 0) return ["auto"];
  return [...THINKING_LEVELS];
}
