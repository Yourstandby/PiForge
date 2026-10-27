/**
 * 单个项目里的会话可见性（纯函数，便于单测）。
 *
 * 为什么需要上限：一个项目堆几十条会话时，展开后会把其他项目整体推到视口外，
 * 必须长时间滚动才能找到别的项目。默认只露最近 N 条，其余靠「显示全部」显式铺开；
 * 日期分组也只展开最新一组。
 */
import type { SessionDateBucket, SessionDateGroup } from "./date-groups.ts";
import type { SessionTreeNode } from "./helpers.ts";

/** 每个项目默认展示的会话条数上限。 */
export const SESSION_PREVIEW_LIMIT = 5;

export interface SessionPreview {
  groups: SessionDateGroup[];
  /** 被上限挡住、当前没渲染的条数。 */
  hiddenCount: number;
  /** 该项目根节点总数（children 不算，它们挂在自己的父节点下面）。 */
  totalCount: number;
}

/**
 * 按上限裁剪日期分组：从最新的一组往后数，凑够 limit 条就停。
 * `expanded` 为真（用户点了「显示全部」或正在搜索）时原样返回。
 */
export function previewSessionGroups(
  groups: SessionDateGroup[],
  options: { limit?: number; expanded?: boolean } = {},
): SessionPreview {
  const totalCount = groups.reduce((sum, group) => sum + group.nodes.length, 0);
  const limit = Math.max(0, options.limit ?? SESSION_PREVIEW_LIMIT);
  if (options.expanded || totalCount <= limit) return { groups, hiddenCount: 0, totalCount };
  const kept: SessionDateGroup[] = [];
  let remaining = limit;
  for (const group of groups) {
    if (remaining <= 0) break;
    const nodes = group.nodes.slice(0, remaining);
    kept.push({ bucket: group.bucket, nodes });
    remaining -= nodes.length;
  }
  return { groups: kept, hiddenCount: totalCount - limit, totalCount };
}

/** 日期分组展开状态在 preferences/state 里的键（项目 + 分组，互不串台）。 */
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
