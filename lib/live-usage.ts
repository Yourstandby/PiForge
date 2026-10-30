/**
 * 流式期间的粗略 Token 估算工具。
 *
 * 这里**不再有实时用量广播**：底部用量条只显示真实 usage 累计（来自 messages
 * 里每条 assistant 的 usage.cost），流式估算曾被当作费用叠加，既有写死单价
 * （每 token 0.000004）的失真，也容易让人误以为是账单。费用一律等模型回报真实
 * usage 后再显示。
 *
 * 保留下来的 estimateTokens 只用于「生成速度 tokens/s」这类无金额的量。
 */

/** 粗略 Token 估算：CJK 约 1 字/token，其它按 4 字符/token。 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (/[\u3000-\u9fff\uff00-\uffef]/.test(char)) cjk += 1;
    else other += 1;
  }
  return Math.max(0, Math.round(cjk + other / 4));
}
