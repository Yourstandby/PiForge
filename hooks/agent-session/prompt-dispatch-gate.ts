/**
 * 「一次发送只能派发一次」的闸门。
 *
 * 只用来挡住**同一次派发的重入**（双击发送、Enter 连按）：从按下发送到宿主 RPC
 * 返回只有几百毫秒。所以闸门必须自带过期时间 —— 以前它只在「出错」或
 * 「agentRunning 翻回 false」时释放，一旦那一轮的 agent_end 没回来（宿主动了、
 * 扩展抛错、事件断了），闸门就永久卡住，之后每次发送都被静默 return：
 * 界面表现就是「消息发出去了，但没有任何下一步」。
 */
export type PromptDispatchState = { current: boolean; startedAt?: number };

/** 闸门最长关闭时间。远超一次 RPC 往返，又短到不会吞掉用户的下一条消息。 */
export const PROMPT_DISPATCH_STALE_MS = 8_000;

export function tryStartPromptDispatch(
  state: PromptDispatchState,
  now: number = Date.now(),
  staleMs: number = PROMPT_DISPATCH_STALE_MS,
): boolean {
  if (state.current && now - (state.startedAt ?? 0) < staleMs) return false;
  state.current = true;
  state.startedAt = now;
  return true;
}

export function finishPromptDispatch(state: PromptDispatchState): void {
  state.current = false;
  state.startedAt = undefined;
}
