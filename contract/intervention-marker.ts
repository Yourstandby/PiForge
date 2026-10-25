/**
 * 人工介入文本的共享标记（Host 生成 / Renderer 识别，两端共用同一份常量）。
 *
 * 为什么需要它：介入指令是 Host 以 user 身份 steer 进会话的，
 * 落盘后和用户亲手打的字长得一模一样 —— 前端会把它渲染成「你」说的蓝气泡，
 * 用户看到自己没说过的话被当成自己的提问（截图里那条系统提示就是这么来的）。
 * 加一个稳定前缀，前端就能把它降级成灰色「系统提示」卡片，并从回合导航里剔除。
 */
export const INTERVENTION_PREFIX = "[系统提示]";

/** 这条用户消息是否由人工介入注入（而非用户亲手输入）。 */
export function isInterventionText(text: unknown): boolean {
  return typeof text === "string" && text.trimStart().startsWith(INTERVENTION_PREFIX);
}
