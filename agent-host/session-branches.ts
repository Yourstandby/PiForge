/**
 * Session branches (v0.5.0 stage 6).
 *
 * Pi session files are already a tree: every entry has `id` + `parentId`, and
 * the session manager keeps a movable leaf pointer. This module exposes that
 * tree and switches the leaf inside the Agent Host:
 *   - live session → `navigateTree()` (refreshes the agent's context)
 *   - cold session → remember the selected leaf for the next `startRpcSession`
 */
import { resolve, sep } from "node:path";
import {
  SessionManager,
  getAgentDir,
  type SessionEntry,
  type SessionTreeNode,
} from "@earendil-works/pi-coding-agent";
import type {
  SessionBranches,
  SessionBranchNode,
  SessionBranchSwitchResult,
  SessionBranchKind,
} from "../contract/domains/sessions.ts";
import { getRpcSession } from "./rpc-manager.ts";
import { setPendingSessionLeaf } from "./session-branch-state.ts";

export type SessionBranchErrorCode =
  | "SESSION_NOT_FOUND"
  | "SESSION_BUSY"
  | "ACCESS_DENIED"
  | "E_INVALID_PARAMS"
  | "INTERNAL";

export class SessionBranchError extends Error {
  readonly code: SessionBranchErrorCode;

  constructor(code: SessionBranchErrorCode, message: string) {
    super(message);
    this.name = "SessionBranchError";
    this.code = code;
  }
}

/** Session files live under the agent dir; refuse anything else. */
export function isSessionFilePath(filePath: string): boolean {
  if (typeof filePath !== "string" || !filePath.trim()) return false;
  try {
    const resolved = resolve(filePath);
    const root = resolve(getAgentDir(), "sessions");
    const rootWithSep = root.endsWith(sep) ? root : root + sep;
    return resolved.startsWith(rootWithSep) && resolved.endsWith(".jsonl");
  } catch {
    return false;
  }
}

function entryKind(entry: SessionEntry): SessionBranchKind {
  if (entry.type !== "message") return "other";
  const role = (entry.message as { role?: string }).role;
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  if (role === "toolResult") return "tool";
  return "other";
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } =>
      Boolean(block) && typeof block === "object" && (block as { type?: string }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join(" ");
}

function entryLabel(entry: SessionEntry): string {
  let text = "";
  if (entry.type === "message") {
    const message = entry.message as { role?: string; content?: unknown; toolName?: string };
    text = textOfContent(message.content);
    if (!text) text = message.role === "assistant" ? "[assistant]" : message.role === "toolResult" ? `[tool ${message.toolName ?? ""}]`.trim() : "";
  } else if (entry.type === "custom_message") {
    text = textOfContent(entry.content);
  } else if (entry.type === "session_info") {
    text = entry.name ?? "";
  }
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return entry.type;
  return clean.length > 80 ? `${clean.slice(0, 77)}…` : clean;
}

function deepestLeaf(node: SessionTreeNode): string {
  if (node.children.length === 0) return node.entry.id;
  return deepestLeaf(node.children[node.children.length - 1]);
}

function flattenTree(nodes: SessionTreeNode[], out: SessionBranchNode[]): void {
  for (const node of nodes) {
    out.push({
      id: node.entry.id,
      parentId: node.entry.parentId,
      timestamp: node.entry.timestamp,
      kind: entryKind(node.entry),
      label: entryLabel(node.entry),
      childCount: node.children.length,
      leafId: deepestLeaf(node),
    });
    flattenTree(node.children, out);
  }
}

interface ResolvedSession {
  manager: SessionManager;
  live: boolean;
}

async function resolveManager(sessionId: string, filePath?: string): Promise<ResolvedSession> {
  const live = getRpcSession(sessionId);
  if (live?.isAlive()) {
    return { manager: live.inner.sessionManager, live: true };
  }
  if (filePath) {
    if (!isSessionFilePath(filePath)) {
      // Custom session dirs are allowed only when the file is one the session
      // store actually knows about.
      const known = (await SessionManager.listAll()).find((candidate) => candidate.id === sessionId);
      if (!known || resolve(known.path) !== resolve(filePath)) {
        throw new SessionBranchError("ACCESS_DENIED", "Not a session file");
      }
    }
    const manager = SessionManager.open(filePath);
    if (manager.getSessionId() !== sessionId) {
      throw new SessionBranchError("E_INVALID_PARAMS", "filePath does not belong to this session");
    }
    return { manager, live: false };
  }
  const sessions = await SessionManager.listAll();
  const info = sessions.find((candidate) => candidate.id === sessionId);
  if (!info) throw new SessionBranchError("SESSION_NOT_FOUND", "Session not found");
  return { manager: SessionManager.open(info.path), live: false };
}

export async function getSessionBranches(input: {
  sessionId: string;
  filePath?: string;
}): Promise<SessionBranches> {
  const sessionId = input.sessionId?.trim();
  if (!sessionId) throw new SessionBranchError("E_INVALID_PARAMS", "sessionId is required");
  const { manager, live } = await resolveManager(sessionId, input.filePath);
  const nodes: SessionBranchNode[] = [];
  flattenTree(manager.getTree(), nodes);
  return { live, leafId: manager.getLeafId(), nodes };
}

export async function switchSessionBranch(input: {
  sessionId: string;
  filePath?: string;
  leafId: string | null;
}): Promise<SessionBranchSwitchResult> {
  const sessionId = input.sessionId?.trim();
  if (!sessionId) throw new SessionBranchError("E_INVALID_PARAMS", "sessionId is required");
  const leafId = input.leafId;
  if (leafId !== null && (typeof leafId !== "string" || !leafId.trim())) {
    throw new SessionBranchError("E_INVALID_PARAMS", "leafId must be a non-empty string or null");
  }
  const { manager, live } = await resolveManager(sessionId, input.filePath);
  if (leafId !== null && !manager.getEntry(leafId)) {
    throw new SessionBranchError("E_INVALID_PARAMS", `Entry ${leafId} not found`);
  }

  if (!live) {
    // The leaf pointer is in memory only; remember it so a later prompt starts
    // the session on the branch the user is looking at.
    setPendingSessionLeaf(sessionId, leafId);
    return { cancelled: false, live: false, leafId };
  }

  const wrapper = getRpcSession(sessionId);
  if (!wrapper?.isAlive()) {
    setPendingSessionLeaf(sessionId, leafId);
    return { cancelled: false, live: false, leafId };
  }
  if (leafId === null) {
    manager.resetLeaf();
    return { cancelled: false, live: true, leafId: null };
  }
  if (wrapper.inner.isStreaming) {
    throw new SessionBranchError(
      "SESSION_BUSY",
      "Wait for the current response to finish before switching branches.",
    );
  }
  const result = await wrapper.inner.navigateTree(leafId, {});
  return {
    cancelled: result.cancelled,
    live: true,
    leafId: manager.getLeafId(),
    ...(result.editorText ? { editorText: result.editorText } : {}),
  };
}
