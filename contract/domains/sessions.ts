/**
 * Session branch switching (v0.5.0 stage 6).
 *
 * Pi session JSONL files already form a tree (`id` + `parentId`). These DTOs
 * expose that tree and the leaf switch to the renderer; the Host owns the
 * reads and the live AgentSession navigation.
 */

export type SessionBranchKind = "user" | "assistant" | "tool" | "other";

export interface SessionBranchNode {
  id: string;
  parentId: string | null;
  timestamp: string;
  kind: SessionBranchKind;
  /** Short preview used by the branch switcher. */
  label: string;
  childCount: number;
  /** Deepest leaf under this node (itself when it has no children). */
  leafId: string;
}

export interface SessionBranches {
  /** True when an AgentSession for this id is live in the Host. */
  live: boolean;
  leafId: string | null;
  nodes: SessionBranchNode[];
}

export interface SessionBranchSwitchResult {
  cancelled: boolean;
  live: boolean;
  /** Leaf after the switch (may be the parent when a user message was selected). */
  leafId: string | null;
  /** Text to put back into the composer (pi's re-edit semantics for user messages). */
  editorText?: string;
}
