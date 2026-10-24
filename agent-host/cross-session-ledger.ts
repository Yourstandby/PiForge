/**
 * 跨会话改动台账（共混方案：改动署名）。
 *
 * 问题：同一个项目里开多个会话并行干活，A 改了文件，B 只会在下次 `read` 时
 * 发现"内容变了"，但不知道**谁**改的、多久之前、用的哪个工具。于是 B 要么整篇
 * 重读，要么直接把 A 的工作覆盖掉。
 *
 * 做法：Host 是单进程，所有会话的 `tool_result` 都从这里过 —— 在一份内存台账里
 * 记下「哪个会话、什么时候、用哪个工具动过哪个文件」；别的会话读同一文件时，
 * `desktop-file-origin` 扩展在 read 结果尾部追加一行署名。
 *
 * 边界（有意为之）：
 *   1. 只记 `write` / `edit` 这类可精确归因的写入工具。`bash` / `powershell` 里
 *      的 `>` 重定向、`sed -i` 无法稳定归因，不记 —— 宁缺毋滥，错误署名比没有更糟。
 *   2. 台账是**提示**不是锁：不阻塞任何工具，只改模型看到的一行文本。
 *   3. 进程内单例；orchestrator worker 在独立进程 + 独立 worktree，不共享台账。
 */
import path from "node:path";

/** 可精确归因到单文件的写入工具。 */
export const FILE_MUTATION_TOOLS = new Set(["write", "edit"]);

/** 台账上限（超出按最旧淘汰），防止长会话无限增长。 */
export const MAX_LEDGER_TOUCHES = 400;
/** 默认只提最近 30 分钟的改动，更早的视为"已经在 git 历史里了"。 */
export const DEFAULT_TOUCH_TTL_MS = 30 * 60 * 1000;

export interface FileTouch {
  /** 归一化后的绝对路径。 */
  path: string;
  /** 写入方会话的工作目录（用来算相对路径）。 */
  cwd: string;
  sessionId: string;
  sessionName: string | null;
  toolName: string;
  /** 毫秒时间戳。 */
  at: number;
}

export interface CrossSessionLedgerState {
  touches: FileTouch[];
}

/** `PIFORGE_CROSS_SESSION_NOTES=0` 可关闭署名提示（A/B 与排障用）。 */
export function crossSessionNotesEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.PIFORGE_CROSS_SESSION_NOTES !== "0";
}

export function isFileMutationTool(toolName: string): boolean {
  return FILE_MUTATION_TOOLS.has(toolName);
}

export function createLedgerState(): CrossSessionLedgerState {
  return { touches: [] };
}

const GLOBAL_KEY = "__piforgeCrossSessionLedger";

/** Host 单进程内的共享台账（HMR 安全，挂 globalThis）。 */
export function sharedLedger(): CrossSessionLedgerState {
  const store = globalThis as unknown as Record<string, CrossSessionLedgerState | undefined>;
  const existing = store[GLOBAL_KEY];
  if (existing) return existing;
  const created = createLedgerState();
  store[GLOBAL_KEY] = created;
  return created;
}

/** 测试用：清空共享台账。 */
export function resetSharedLedger(): void {
  const store = globalThis as unknown as Record<string, CrossSessionLedgerState | undefined>;
  store[GLOBAL_KEY] = createLedgerState();
}

/** 统一的路径归一化：相对 cwd 解析成绝对路径，斜杠统一。 */
export function normalizeTouchPath(cwd: string, filePath: string): string {
  return path.resolve(cwd, filePath);
}

/** 淘汰过期条目，再把最近一条前置。 */
export function recordFileTouch(
  state: CrossSessionLedgerState,
  touch: Omit<FileTouch, "path"> & { path: string },
  now: number = Date.now()
): FileTouch {
  const entry: FileTouch = { ...touch, path: normalizeTouchPath(touch.cwd, touch.path) };
  state.touches = state.touches.filter(
    (item) => item.at >= now - DEFAULT_TOUCH_TTL_MS && item.path !== entry.path
  );
  state.touches.unshift(entry);
  if (state.touches.length > MAX_LEDGER_TOUCHES) {
    state.touches.length = MAX_LEDGER_TOUCHES;
  }
  return entry;
}

export interface ForeignTouchQuery {
  path: string;
  cwd: string;
  sessionId: string;
  now?: number;
  ttlMs?: number;
}

/** 同 cwd 内、最近被**别的会话**动过的最新一条记录；没有则 null。 */
export function findForeignTouch(
  state: CrossSessionLedgerState,
  query: ForeignTouchQuery
): FileTouch | null {
  const now = query.now ?? Date.now();
  const ttl = query.ttlMs ?? DEFAULT_TOUCH_TTL_MS;
  const target = normalizeTouchPath(query.cwd, query.path);
  let best: FileTouch | null = null;
  for (const touch of state.touches) {
    if (touch.path !== target) continue;
    if (touch.sessionId === query.sessionId) continue;
    if (touch.cwd !== query.cwd) continue;
    if (now - touch.at > ttl || now - touch.at < 0) continue;
    if (!best || touch.at > best.at) best = touch;
  }
  return best;
}

/** `just now` / `4 min ago` / `2 h ago` —— 供提示文案使用。 */
export function formatAge(at: number, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ago`;
}

/** 会话显示名：标题优先，否则用短 id，保证每条提示都能落到具体会话。 */
export function sessionLabel(touch: Pick<FileTouch, "sessionId" | "sessionName">): string {
  const name = touch.sessionName?.trim();
  if (name) return `「${name}」`;
  return `#${touch.sessionId.slice(0, 6)}`;
}

/** 相对 cwd 的路径，跨盘符时回退绝对路径。 */
export function displayPath(touch: Pick<FileTouch, "path" | "cwd">): string {
  const rel = path.relative(touch.cwd, touch.path);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return touch.path;
  return rel.replaceAll("\\", "/");
}

/**
 * read 结果尾部追加的那一行：谁、多久之前、用什么工具改的，以及动手前该做什么。
 */
export function foreignTouchNote(touch: FileTouch, now: number = Date.now()): string {
  const rel = displayPath(touch);
  return (
    `Note: ${rel} was also modified ${formatAge(touch.at, now)} by another session ` +
    `${sessionLabel(touch)} (${touch.toolName}). Run \`git diff -- ${rel}\` before overwriting it.`
  );
}

/**
 * 写入成功后补的一句：你刚覆盖的文件，别的会话不久前也改过。用于让模型自己
 * 决定要不要回头对齐（不阻断、不自动回滚）。
 */
export function overwriteNote(touch: FileTouch, now: number = Date.now()): string {
  const rel = displayPath(touch);
  return (
    `Note: ${rel} had also been modified ${formatAge(touch.at, now)} by another session ` +
    `${sessionLabel(touch)} (${touch.toolName}). Check \`git diff -- ${rel}\` to confirm you did not discard their work.`
  );
}
