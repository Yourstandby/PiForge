/**
 * Branch switcher view model.
 *
 * The Host returns the flattened JSONL tree; the transcript only needs, per
 * message, its sibling alternatives and the leaf each alternative ends at.
 */
import type { SessionBranchNode } from "@contract/domains/sessions";

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
