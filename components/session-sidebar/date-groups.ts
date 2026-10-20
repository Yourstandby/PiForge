/**
 * Date buckets for the session sidebar (today / yesterday / this week / ...).
 * Uses local calendar boundaries, not fixed 24h windows, so a session created
 * at 23:59 still lands in "yesterday" after midnight.
 */
import type { SessionTreeNode } from "./helpers.ts";

export type SessionDateBucket = "today" | "yesterday" | "week" | "month" | "older";

export const SESSION_DATE_BUCKETS: readonly SessionDateBucket[] = [
  "today",
  "yesterday",
  "week",
  "month",
  "older",
];

function startOfDay(time: number, daysAgo = 0): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - daysAgo);
  return date.getTime();
}

export function sessionDateBucket(modified: string, now: number = Date.now()): SessionDateBucket {
  const time = Date.parse(modified);
  if (!Number.isFinite(time)) return "older";
  const today = startOfDay(now);
  if (time >= today) return "today";
  if (time >= startOfDay(now, 1)) return "yesterday";
  if (time >= startOfDay(now, 7)) return "week";
  if (time >= startOfDay(now, 30)) return "month";
  return "older";
}

export interface SessionDateGroup {
  bucket: SessionDateBucket;
  nodes: SessionTreeNode[];
}

/** Root nodes are already sorted by `modified` desc, so buckets stay contiguous. */
export function groupSessionNodesByDate(
  nodes: SessionTreeNode[],
  now: number = Date.now(),
): SessionDateGroup[] {
  const groups: SessionDateGroup[] = [];
  for (const node of nodes) {
    const bucket = sessionDateBucket(node.session.modified, now);
    const last = groups[groups.length - 1];
    if (last && last.bucket === bucket) last.nodes.push(node);
    else groups.push({ bucket, nodes: [node] });
  }
  return groups;
}
