/**
 * Branch switcher view model.
 *
 * The Host returns the flattened JSONL tree; the transcript only needs, per
 * message, its sibling alternatives and the leaf each alternative ends at.
 */
import type { SessionBranchNode } from "@contract/domains/sessions";
import type { SessionEntry, SessionTreeNode } from "./types";

export interface BranchSwitchTarget {
  nodeId: string;
  leafId: string;
}

export interface BranchSwitchInfo {
  /** 0-based index of this message among its siblings. */
  index: number;
  total: number;
  /** Sibling alternatives in display order (deepest leaf of each subtree). */
  targets: BranchSwitchTarget[];
}

/**
 * Host 的分支图（扁平 id/parentId + 最深叶）→ BranchNavigator 要的树。
 *
 * 会话接口返回的 `tree` 只覆盖当前路径，兄弟分叉不在里面，于是「分支」下拉
 * 会误报「当前会话没有分支」。分支图来自 getBranches，是完整树，用它更可靠。
 * 行被点中时切到该节点的 `leafId`（最深叶），而不是节点自身。
 */
export function branchNodesToTree(
  nodes: readonly SessionBranchNode[],
): SessionTreeNode[] {
  if (nodes.length === 0) return [];
  const byId = new Map<string, SessionTreeNode>();
  for (const node of nodes) {
    byId.set(node.id, {
      entry: {
        type: node.kind === "user" || node.kind === "assistant" ? "message" : "other",
        id: node.id,
        parentId: node.parentId,
        timestamp: node.timestamp,
      } as unknown as SessionEntry,
      label: node.label,
      leafId: node.leafId,
      children: [],
    });
  }
  const roots: SessionTreeNode[] = [];
  for (const node of nodes) {
    const self = byId.get(node.id);
    if (!self) continue;
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) parent.children.push(self);
    else roots.push(self);
  }
  return roots;
}

/**
 * Map message entry id → switcher info. Only user/assistant nodes with at
 * least one sibling get an entry.
 */
export function buildBranchSwitchMap(
  nodes: readonly SessionBranchNode[],
): Map<string, BranchSwitchInfo> {
  const byParent = new Map<string | null, SessionBranchNode[]>();
  for (const node of nodes) {
    const siblings = byParent.get(node.parentId) ?? [];
    siblings.push(node);
    byParent.set(node.parentId, siblings);
  }

  const map = new Map<string, BranchSwitchInfo>();
  for (const node of nodes) {
    if (node.kind !== "user" && node.kind !== "assistant") continue;
    const siblings = byParent.get(node.parentId) ?? [];
    // Only same-kind siblings are alternatives (tool results are transient).
    const peers = siblings.filter((sibling) => sibling.kind === node.kind);
    if (peers.length < 2) continue;
    const index = peers.findIndex((sibling) => sibling.id === node.id);
    if (index < 0) continue;
    map.set(node.id, {
      index,
      total: peers.length,
      targets: peers.map((sibling) => ({ nodeId: sibling.id, leafId: sibling.leafId })),
    });
  }
  return map;
}
