/**
 * 子 Agent 的会话隔离（开发版专用约束 3）。
 *
 * 现状：`spawn_agent` 与 `herdr_*` 都用 `SessionManager.inMemory(cwd)` ——
 * **根本不写盘**，所以天然不会污染 `~/.pi/agent/sessions`（这也是为什么
 * `audit:token` 的统计口径里从来没有子 Agent 的记录）。
 *
 * 那这个模块解决什么？两件事：
 *   1. **防回归**：以后谁把子 Agent 改成持久化会话，必须显式接受这个守卫 ——
 *      把落点指到 `PIFORGE_SESSION_DIR`，而不是共享目录；
 *   2. **给需要落盘的实验/工具一条正规通道**：A/B 脚本、排障用的单轮 runner
 *      用 `PIFORGE_SESSION_DIR` 指定独立目录，避免污染审计口径。
 *
 * 纯函数 + 常量，不 import 任何 FS 或 SDK，便于单测。
 */

export const SESSION_DIR_ENV = "PIFORGE_SESSION_DIR";

export interface SessionIsolationDecision {
  /** 子 Agent / 实验会话应该写到哪（`null` = 纯内存，不落盘）。 */
  dir: string | null;
  source: "env" | "default_in_memory";
  reason: string;
}

/** 规范化路径用于比较（Windows 大小写不敏感、斜杠方向不敏感）。 */
export function normalizeForCompare(input: string): string {
  return input.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * 解析 `PIFORGE_SESSION_DIR`：
 *   - 未设置 / 空 → `null`（保持 in-memory，零落盘）
 *   - 设置了 → 用它，但必须与共享会话根目录区分开
 */
export function resolveChildSessionDir(
  env: Record<string, string | undefined> = process.env,
  sharedSessionsRoot?: string,
): SessionIsolationDecision {
  const raw = env[SESSION_DIR_ENV]?.trim();
  if (!raw) {
    return {
      dir: null,
      source: "default_in_memory",
      reason: "未设置 PIFORGE_SESSION_DIR：子 Agent 使用 in-memory 会话（不落盘，天然隔离）",
    };
  }
  if (sharedSessionsRoot) {
    const violation = checkSharedSessionsOverlap(raw, sharedSessionsRoot);
    if (violation) {
      return {
        dir: null,
        source: "env",
        reason: `${SESSION_DIR_ENV} 指向共享会话目录（${violation}），拒绝使用；回落 in-memory`,
      };
    }
  }
  return { dir: raw, source: "env", reason: `${SESSION_DIR_ENV}=${raw}` };
}

/**
 * 返回违规描述（`null` = 没问题）：目标目录**落在**共享会话根目录内 → 就是污染。
 * 反过来（共享目录在目标目录里）不算违规，但也不推荐，这里只拦"写进共享"这一种。
 */
export function checkSharedSessionsOverlap(targetDir: string, sharedSessionsRoot: string): string | null {
  const target = normalizeForCompare(targetDir);
  const shared = normalizeForCompare(sharedSessionsRoot);
  if (target === shared) return "与共享根目录相同";
  if (target.startsWith(`${shared}/`)) return "位于共享根目录之内";
  return null;
}

/**
 * 子 Agent 的会话落点是否安全：给了目录就必须给出隔离理由。
 * 返回 `true` 表示"可以继续"，`false` 表示调用方应按 `reason` 拒绝或回落。
 */
export function isIsolatedChildSession(dir: string | null, sharedSessionsRoot?: string): boolean {
  if (dir === null) return true; // in-memory 永远安全
  if (!sharedSessionsRoot) return true;
  return checkSharedSessionsOverlap(dir, sharedSessionsRoot) === null;
}
