/**
 * 跨会话改动署名（共混方案第 1 步：让并行会话彼此看得见）。
 *
 * 每个会话都只知道自己写过什么；`write` / `edit` 成功后本扩展把「谁动了哪个
 * 文件」记进 Host 进程内的共享台账（`cross-session-ledger.ts`）。别的会话再
 * `read` 同一文件时，结果尾部多一行署名：谁、多久之前、用的哪个工具、该先
 * 跑哪条 `git diff`。
 *
 * 只读、只注解，不改工具语义：
 *   - 不阻塞任何调用，不自动重读，不回滚；
 *   - 错误结果一律原样透传（失败的写入没有归因价值）；
 *   - 自己改的文件对自己不提示（去噪）；
 *   - 不同 cwd 的会话互不干扰。
 *
 * 注册顺序要求：必须排在 `desktop-dedupe` **之后**。去重扩展先判断"内容是否
 * 与上次相同"，本扩展再在最终文本尾部追加一行 —— 顺序反了会把去重的哈希搞脏。
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  InlineExtension,
} from "./sdk-adapter.ts";
import {
  crossSessionNotesEnabled,
  findForeignTouch,
  foreignTouchNote,
  isFileMutationTool,
  overwriteNote,
  recordFileTouch,
  sharedLedger,
  type CrossSessionLedgerState,
} from "./cross-session-ledger.ts";

export interface FileOriginStats {
  touchesRecorded: number;
  readNotes: number;
  overwriteNotes: number;
}

export function emptyFileOriginStats(): FileOriginStats {
  return { touchesRecorded: 0, readNotes: 0, overwriteNotes: 0 };
}

/** 从工具入参里取目标文件路径（`read` / `write` / `edit` 都用 `path`）。 */
export function targetPathOf(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const candidate = (input as { path?: unknown }).path;
  if (typeof candidate !== "string") return null;
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : null;
}

interface SessionIdentity {
  sessionId: string;
  sessionName: string | null;
}

function identityOf(ctx: ExtensionContext): SessionIdentity | null {
  try {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!sessionId) return null;
    return { sessionId, sessionName: ctx.sessionManager.getSessionName() ?? null };
  } catch {
    return null;
  }
}

export function createDesktopFileOriginFactory(
  options: {
    enabled?: () => boolean;
    ledger?: CrossSessionLedgerState;
    now?: () => number;
  } = {}
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    const enabled = options.enabled ?? (() => crossSessionNotesEnabled());
    const ledger = options.ledger ?? sharedLedger();
    const now = options.now ?? (() => Date.now());
    const stats = emptyFileOriginStats();

    pi.on("tool_result", (event, ctx) => {
      if (!enabled()) return;
      if (event.isError) return;
      const target = targetPathOf(event.input);
      if (!target) return;
      const identity = identityOf(ctx);
      if (!identity) return;

      if (event.toolName === "read") {
        const touch = findForeignTouch(ledger, {
          path: target,
          cwd: ctx.cwd,
          sessionId: identity.sessionId,
          now: now(),
        });
        if (!touch) return;
        stats.readNotes += 1;
        return {
          content: [...event.content, { type: "text" as const, text: foreignTouchNote(touch, now()) }],
        };
      }

      if (!isFileMutationTool(event.toolName)) return;

      // 先看"动手之前"别人有没有改过，再登记自己这一笔。
      const previous = findForeignTouch(ledger, {
        path: target,
        cwd: ctx.cwd,
        sessionId: identity.sessionId,
        now: now(),
      });
      recordFileTouch(
        ledger,
        {
          path: target,
          cwd: ctx.cwd,
          sessionId: identity.sessionId,
          sessionName: identity.sessionName,
          toolName: event.toolName,
          at: now(),
        },
        now()
      );
      stats.touchesRecorded += 1;
      if (!previous) return;
      stats.overwriteNotes += 1;
      return {
        content: [...event.content, { type: "text" as const, text: overwriteNote(previous, now()) }],
      };
    });

    pi.on("session_shutdown", () => {
      if (process.env.PIFORGE_DEBUG_FILE_ORIGIN === "1") {
        console.log("[file-origin]", stats);
      }
    });
  };
}

export function desktopFileOriginInlineExtension(
  options: {
    enabled?: () => boolean;
    ledger?: CrossSessionLedgerState;
    now?: () => number;
  } = {}
): InlineExtension {
  return {
    name: "desktop-file-origin",
    factory: createDesktopFileOriginFactory(options),
  };
}
