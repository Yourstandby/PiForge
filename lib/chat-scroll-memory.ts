/**
 * 隐藏面板里的滚动位置记忆。
 *
 * Workbench 用 `display:none` 藏非活动标签，隐藏后 `scrollTop` 读出来恒为 0，
 * `clientHeight` 也是 0。旧代码在「切走」的 layout effect 里直接读 `scrollTop`，
 * 于是记下的是 0 —— 切回来就停在会话第一条消息（用户看到的是"跳回第一次对话"）。
 *
 * 规则：只要容器此刻量不出高度（或者读出 0 但其实有历史位置），就用滚动过程中
 * 持续记录的最后位置。
 */
export function savedScrollTop(
  domTop: number,
  clientHeight: number,
  lastKnownTop: number,
): number {
  if (clientHeight <= 0) return Math.max(0, lastKnownTop);
  if (domTop === 0 && lastKnownTop > 0) return lastKnownTop;
  return Math.max(0, domTop);
}
