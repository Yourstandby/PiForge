/**
 * 实时用量微广播（streaming 期间）。
 *
 * 流式输出时每来一个增量就更新一次；订阅方（StatsBar）用 **ref 直接改 DOM**，
 * 不 setState，因此不会触发整个界面重渲染 —— 只有那几个数字的文本节点在变。
 */

export interface LiveUsage {
  /** 本次流式已经产出的（估算）Token 数。 */
  tokens: number;
  /** 这段流式已经累积的（估算）费用，单位美元。 */
  cost: number;
}

type Listener = (usage: LiveUsage | null) => void;

let current: LiveUsage | null = null;
const listeners = new Set<Listener>();

export function setLiveUsage(usage: LiveUsage | null): void {
  current = usage;
  for (const listener of listeners) listener(current);
}

export function getLiveUsage(): LiveUsage | null {
  return current;
}

export function subscribeLiveUsage(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

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
