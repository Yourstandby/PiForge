/**
 * 会话按时间分桶（纯函数）。
 *
 * 侧栏的目标形态：按「7 天 / 月 / 年」收纳，折叠头显示的数字必须等于点开后
 * 看到的真实条数。因此这里只分组、不裁剪 —— 一旦在分组阶段按上限截断，
 * 折叠头的 count 和点开后的内容就会各说各话（历史 bug：头显示 6 条，点开一片空）。
 *
 * 分辨率随距离衰减：最近按天，一年内按自然月，更早按自然年。
 */
import type { SessionTreeNode } from "./helpers.ts";

export type SessionDateBucket =
  | "today"
  | "yesterday"
  | "week"
  | `m:${string}`
  | `y:${string}`
  | "unknown";

export interface SessionDateGroup {
  bucket: SessionDateBucket;
  nodes: SessionTreeNode[];
  /** 只数根会话：分支子节点挂在父节点下面，不重复计数。 */
  count: number;
}

/** 今天 / 昨天之后，最近 6 个自然日归到「过去 7 天」。 */
const WEEK_BUCKET_DAYS = 6;
/** 12 个月以内按自然月，更早按自然年。 */
const MONTH_BUCKET_SPAN = 11;

const DAY_MS = 86_400_000;

function startOfDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function monthBucket(year: number, month: number): SessionDateBucket {
  return `m:${year}-${String(month + 1).padStart(2, "0")}`;
}

/**
 * 某条会话落到哪个桶。用本地日历边界（不是固定 24h 窗口），
 * 这样 23:59 创建的会话过零点后仍然落在「昨天」。
 */
export function sessionDateBucket(modified: string, now: number = Date.now()): SessionDateBucket {
  const time = Date.parse(modified);
  if (!Number.isFinite(time)) return "unknown";
  // round 而不是 floor：夏令时切换那天相差 23/25 小时。
  const daysAgo = Math.round((startOfDay(now) - startOfDay(time)) / DAY_MS);
  if (daysAgo <= 0) return "today";
  if (daysAgo === 1) return "yesterday";
  if (daysAgo <= WEEK_BUCKET_DAYS) return "week";
  const date = new Date(time);
  const today = new Date(now);
  const monthsAgo = (today.getFullYear() - date.getFullYear()) * 12 + (today.getMonth() - date.getMonth());
  if (monthsAgo <= MONTH_BUCKET_SPAN) return monthBucket(date.getFullYear(), date.getMonth());
  return `y:${date.getFullYear()}`;
}

/**
 * 按时间分桶。输入已按 modified 降序；用 Map 合并而不是只比较相邻项，
 * 这样即使调用方传进来的顺序不严格，同一个桶也不会被拆成两段。
 */
export function groupSessionNodesByDate(
  nodes: SessionTreeNode[],
  now: number = Date.now(),
): SessionDateGroup[] {
  const groups: SessionDateGroup[] = [];
  const byBucket = new Map<SessionDateBucket, SessionDateGroup>();
  for (const node of nodes) {
    const bucket = sessionDateBucket(node.session.modified, now);
    let group = byBucket.get(bucket);
    if (!group) {
      group = { bucket, nodes: [], count: 0 };
      byBucket.set(bucket, group);
      groups.push(group);
    }
    group.nodes.push(node);
    group.count += 1;
  }
  // unknown 放最后：它没有时间语义，夹在中间会打断「按时序倒序」的读法。
  const unknownIndex = groups.findIndex((group) => group.bucket === "unknown");
  if (unknownIndex >= 0 && unknownIndex !== groups.length - 1) {
    const [unknown] = groups.splice(unknownIndex, 1);
    groups.push(unknown);
  }
  return groups;
}

const MONTH_LABELS_EN = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * 月 / 年桶显示成什么。today / yesterday / week / unknown 走 i18n 静态键，
 * 这里返回 null 交给调用方。
 */
export function formatDateBucketLabel(bucket: SessionDateBucket, locale: string): string | null {
  const chinese = locale.toLowerCase().startsWith("zh");
  if (bucket.startsWith("m:")) {
    const [year, month] = bucket.slice(2).split("-").map(Number);
    return chinese ? `${year}年${month}月` : `${MONTH_LABELS_EN[month - 1]} ${year}`;
  }
  if (bucket.startsWith("y:")) {
    const year = bucket.slice(2);
    return chinese ? `${year}年` : year;
  }
  return null;
}
