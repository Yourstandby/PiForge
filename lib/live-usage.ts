/**
 * 实时用量微广播（streaming 期间）。
 *
 * 流式输出时每来一个增量就更新一次；订阅方（UsageStrip）用 **ref 直接改 DOM**，
 * 不 setState，因此不会触发整个界面重渲染 —— 只有那几个数字的文本节点在变。
 *
 * 必须带 sessionId：多标签 / 多会话并行时，每个 ChatSurface 都会往这里写。
 * 早期版本没有归属，任何会话的流式增量都会叠加到所有用量条上（A 项目在跑，
 * B 标签的费用跟着涨），订阅方现在只认自己那条会话的实时值。
 */

export interface LiveUsage {
  /** 产生这次实时增量的会话 id。 */
  sessionId: string;
  /** 本次流式已经产出的（估算）Token 数。 */
  tokens: number;
  /** 这段流式已经累积的（估算）费用，单位美元。 */
  cost: number;
}

type Listener = (usage: LiveUsage | null) => void;

interface Entry {
  sessionId: string | null;
  fn: Listener;
}

let current: LiveUsage | null = null;
const listeners = new Set<Entry>();

/** 订阅方看到的值：只有归属同一会话时才给数据，否则一律 null（= 没有实时增量）。 */
function valueFor(entry: Entry): LiveUsage | null {
  if (!current) return null;
  if (!entry.sessionId || entry.sessionId !== current.sessionId) return null;
  return current;
}

export function setLiveUsage(usage: LiveUsage | null): void {
  current = usage;
  for (const entry of listeners) entry.fn(valueFor(entry));
}

/**
 * 只清掉属于该会话的实时值。
 * 直接 `setLiveUsage(null)` 会把别的会话正在跑的实时数字也抹掉。
 */
export function clearLiveUsage(sessionId: string | null): void {
  if (!current) return;
  if (sessionId && current.sessionId !== sessionId) return;
  setLiveUsage(null);
}

/** 读当前实时值；传 sessionId 时不属于该会话就返回 null。 */
export function getLiveUsage(sessionId?: string | null): LiveUsage | null {
  if (!current) return null;
  if (!sessionId) return current;
  return current.sessionId === sessionId ? current : null;
}

export function subscribeLiveUsage(listener: Listener, sessionId: string | null = null): () => void {
  const entry: Entry = { sessionId, fn: listener };
  listeners.add(entry);
  listener(valueFor(entry));
  return () => {
    listeners.delete(entry);
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
