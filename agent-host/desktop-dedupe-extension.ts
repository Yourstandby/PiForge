/**
 * 每轮增量去重（第 6 步）：同一文件同一区间的重复 `read`、同一条命令的重复执行，
 * 不再把同样的正文整段回放给模型。
 *
 * 原则：
 *   1. **只动单次返回内容**，不动历史轮次、不做压缩、不删任何工具；
 *   2. **错误永远完整返回**：`isError`、非零退出码、异常/堆栈一律原样透传，不去重不截断；
 *   3. **先验证再省略**：`read` 用「同一路径+同一区间+文件 mtime/size 未变+内容哈希相同」
 *      四重校验；文件被改过就照常回全文（模型不会因为被省略而信息不足）；
 *   4. 被省略的正文仍然在会话记录里（上一条 toolResult），模型能凭 toolCallId 找到；
 *      大输出依旧落盘，`tool_history_get` 可翻页。
 *
 * 省的是**重复内容**，不是信息。
 */
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionFactory, InlineExtension } from "./sdk-adapter.ts";

/** 最多记住多少条（按 LRU 淘汰，防止长会话里无限增长）。 */
const MAX_ENTRIES = 128;
/** 单条命令输出短于这个长度就没必要去重（省不下多少）。 */
const MIN_DEDUPE_CHARS = 400;

/** `PIFORGE_DEDUPE_TOOL_RESULTS=0` 可关闭（A/B 实测用）。 */
export function dedupeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.PIFORGE_DEDUPE_TOOL_RESULTS !== "0";
}

export function normalizeBashCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

export function fileStamp(filePath: string): string | null {
  try {
    const stat = statSync(filePath);
    return `${stat.size}:${Math.round(stat.mtimeMs)}`;
  } catch {
    return null;
  }
}

export function contentHash(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

export interface ReadCacheEntry {
  toolCallId: string;
  hash: string;
  stamp: string;
  chars: number;
}

export interface BashCacheEntry {
  toolCallId: string;
  hash: string;
  text: string;
}

export interface DedupeStats {
  readHits: number;
  bashHits: number;
  readMisses: number;
  bashMisses: number;
  /** 因错误而跳过去重的次数（应该全部按原样返回）。 */
  errorPassThroughs: number;
}

export function emptyDedupeStats(): DedupeStats {
  return { readHits: 0, bashHits: 0, readMisses: 0, bashMisses: 0, errorPassThroughs: 0 };
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && typeof block === "object" && "text" in block ? String(block.text) : ""))
    .join("");
}

/**
 * 纯函数版 `read` 去重判定（便于单测）。
 * 返回 null 表示照常返回全文；返回字符串表示用这句替代。
 */
export function readDedupeReplacement(input: {
  cache: Map<string, ReadCacheEntry>;
  key: string;
  toolCallId: string;
  stamp: string | null;
  text: string;
}): string | null {
  const { cache, key, toolCallId, stamp, text } = input;
  if (stamp === null) return null;
  if (text.length < MIN_DEDUPE_CHARS) return null;
  const hash = contentHash(text);
  const previous = cache.get(key);
  cache.delete(key);
  cache.set(key, { toolCallId, hash, stamp, chars: text.length });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  if (!previous) return null;
  if (previous.hash !== hash || previous.stamp !== stamp) return null;
  return `Unchanged since toolCall ${previous.toolCallId}: same path and range, file not modified (${previous.chars} chars). Use that result instead of re-reading.`;
}

/**
 * 纯函数版 `bash` 去重判定（便于单测）。
 * 成功且输出一致的重复命令 → 一句话；输出有尾部差异 → 只回差异部分。
 */
export function bashDedupeReplacement(input: {
  cache: Map<string, BashCacheEntry>;
  key: string;
  toolCallId: string;
  text: string;
}): string | null {
  const { cache, key, toolCallId, text } = input;
  if (text.length < MIN_DEDUPE_CHARS) return null;
  const hash = contentHash(text);
  const previous = cache.get(key);
  cache.delete(key);
  cache.set(key, { toolCallId, hash, text });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  if (!previous) return null;
  if (previous.hash === hash) {
    return `Unchanged since toolCall ${previous.toolCallId}: same command, identical output (${text.length} chars).`;
  }
  // 只在「新输出以旧输出为前缀」时回尾部差异；否则说明命令行为变了，照常回全文。
  if (!text.startsWith(previous.text)) return null;
  const tail = text.slice(previous.text.length);
  if (tail.trim().length === 0) {
    return `Unchanged since toolCall ${previous.toolCallId}: same command, identical output (${previous.text.length} chars).`;
  }
  return `Same as toolCall ${previous.toolCallId} plus ${tail.length} new chars at the end:\n${tail}`;
}

export function createDesktopDedupeFactory(
  options: { enabled?: () => boolean } = {}
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    const readCache = new Map<string, ReadCacheEntry>();
    const bashCache = new Map<string, BashCacheEntry>();
    const stats = emptyDedupeStats();
    const enabled = options.enabled ?? (() => dedupeEnabled());

    pi.on("tool_result", (event, ctx) => {
      if (!enabled()) return;
      if (event.isError) {
        stats.errorPassThroughs += 1;
        return;
      }
      const text = textOf(event.content);

      if (event.toolName === "read") {
        const input = event.input as { path?: unknown; offset?: unknown; limit?: unknown };
        if (typeof input.path !== "string") return;
        const absolute = path.resolve(ctx.cwd ?? process.cwd(), input.path);
        const key = `${absolute}|${String(input.offset ?? "")}|${String(input.limit ?? "")}`;
        const replacement = readDedupeReplacement({
          cache: readCache,
          key,
          toolCallId: event.toolCallId,
          stamp: fileStamp(absolute),
          text,
        });
        if (replacement) {
          stats.readHits += 1;
          return { content: [{ type: "text" as const, text: replacement }] };
        }
        stats.readMisses += 1;
        return;
      }

      if (event.toolName === "bash" || event.toolName === "powershell") {
        const input = event.input as { command?: unknown };
        if (typeof input.command !== "string") return;
        const details = event.details as { exitCode?: unknown } | undefined;
        const failed =
          (typeof details?.exitCode === "number" && details.exitCode !== 0) ||
          /exited with code [1-9]/i.test(text);
        if (failed) {
          // 失败详情永远完整返回，不参与去重。
          stats.errorPassThroughs += 1;
          return;
        }
        const key = normalizeBashCommand(input.command);
        const replacement = bashDedupeReplacement({
          cache: bashCache,
          key,
          toolCallId: event.toolCallId,
          text,
        });
        if (replacement) {
          stats.bashHits += 1;
          return { content: [{ type: "text" as const, text: replacement }] };
        }
        stats.bashMisses += 1;
        return;
      }
    });

    // 诊断：PIFORGE_DEBUG_DEDUPE=1 时在会话结束打印命中情况。
    pi.on("session_shutdown", () => {
      if (process.env.PIFORGE_DEBUG_DEDUPE === "1") {
        console.log("[dedupe]", stats);
      }
    });
  };
}

export function desktopDedupeInlineExtension(
  options: { enabled?: () => boolean } = {}
): InlineExtension {
  return {
    name: "desktop-dedupe",
    factory: createDesktopDedupeFactory(options),
  };
}
