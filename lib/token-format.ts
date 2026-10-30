/**
 * Token 数量缩写：< 1000 给精确整数，>= 1000 用一位小数缩写（1.0K / 1.2M）。
 *
 * 「计费 tokens」由费用 ÷ 单价折出来，天然带一长串小数；先取整再缩写，
 * 避免界面上出现 7,215.6383 这种数字。
 */
export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  const tokens = Math.round(value);
  if (tokens < 1_000) return tokens.toLocaleString();
  // 999,950 以上四舍五入到 K 会变成 1000.0K，直接进位到 M。
  if (tokens < 999_950) return `${(tokens / 1_000).toFixed(1)}K`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}
