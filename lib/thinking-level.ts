/**
 * 思考强度（reasoning effort）的共享枚举与默认值。
 *
 * 放在 lib 而不是 components 里，是因为 Host 侧设置补写、会话重置 hooks
 * 与 UI 菜单都要用同一个默认值 —— 三处各写一份就会出现「面板显示均衡、
 * 实际按别的档位跑」的双源问题。
 *
 * 默认 "medium"（均衡）：与「常规设置 · 默认思考等级」的兜底值
 * （`app/api/settings`）以及 pi settings.json 的 defaultThinkingLevel 对齐。
 */
export type ThinkingLevelOption =
  | "auto"
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export const THINKING_LEVEL_OPTIONS: readonly ThinkingLevelOption[] = [
  "auto",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** 新会话 / 会话态未就绪时的默认思考等级：均衡。 */
export const DEFAULT_THINKING_LEVEL: ThinkingLevelOption = "medium";

export function isThinkingLevelOption(value: unknown): value is ThinkingLevelOption {
  return typeof value === "string" && (THINKING_LEVEL_OPTIONS as readonly string[]).includes(value);
}
