/**
 * 「上下文已压缩」提示文案。
 *
 * 单独抽出来是为了可测：这段文字直接出现在用户眼前，压缩前后两个数字必须一致地
 * 呈现（之前压缩完成后界面毫无反馈，用户只看到底部的 token 数突然变了，而挂着的
 * 却还是压缩前的「恢复将重发 ≈100k tok」）。
 */
export interface CompactionNoticeNumbers {
  tokensBefore: number | null;
  tokensAfter: number | null;
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

/**
 * @param notice pi 给出的压缩前后估算；缺一个或都为 0 时退化成不带数字的说法。
 */
export function compactionNoticeText(notice: CompactionNoticeNumbers): string {
  const before = notice.tokensBefore;
  const after = notice.tokensAfter;
  if (before && after) {
    return `上下文已自动压缩：≈${formatTokens(before)} → ≈${formatTokens(after)} tok`;
  }
  if (before) return `上下文已自动压缩（压缩前 ≈${formatTokens(before)} tok）`;
  return "上下文已自动压缩，历史摘要已生成";
}
