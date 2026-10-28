/**
 * 日期分组的展开状态（纯函数）。
 *
 * 分组本身在 date-groups.ts 完成，那里永远返回全量分桶、不做裁剪，
 * 所以「点开某一组」只是纯状态变更：不触发加载，也不会点开是空的。
 */
import type { SessionDateBucket } from "./date-groups.ts";
import type { SessionTreeNode } from "./helpers.ts";

/** 日期分组展开状态在 state 里的键（项目 + 分组，互不串台）。 */
export function dateGroupStateKey(projectKey: string, bucket: SessionDateBucket): string {
  return `${projectKey}\u0000${bucket}`;
}

/** 某项目某个日期分组当前是否展开：用户点过就以点击为准，否则用缺省值。 */
export function dateGroupOpen(
  state: Record<string, boolean>,
  projectKey: string,
  bucket: SessionDateBucket,
  fallback: boolean,
): boolean {
  const value = state[dateGroupStateKey(projectKey, bucket)];
  return typeof value === "boolean" ? value : fallback;
}

/** 选中的会话是否落在这一组里（含分支子节点）：是则强制展开，否则选中项会消失。 */
export function dateGroupContainsSession(nodes: SessionTreeNode[], sessionId: string | null): boolean {
  if (!sessionId) return false;
  return nodes.some((node) => node.session.id === sessionId || dateGroupContainsSession(node.children, sessionId));
}

/** 缺省展开的分组：只有今天和昨天，其余收起来（点开即见，不需要等加载）。 */
export function dateGroupOpenByDefault(bucket: SessionDateBucket): boolean {
  return bucket === "today" || bucket === "yesterday";
}
