/**
 * 兼容转发：实现在 `lib/context-budget.ts`。
 *
 * 前端要能自己算上下文预算（避免 host 快照与 SSE 读到的 contextUsage 版本
 * 不一致，导致「用量与额度」和底部一行显示对不上），所以把纯函数挪到 lib，
 * host 侧仍然从这里导入。
 */
export { describeContextBudget } from "../lib/context-budget.ts";
