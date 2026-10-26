/**
 * 主窗口「关闭按钮」行为的偏好（Electron Main 独占，Next / Agent Host 都不读）。
 *
 * - `ask`（默认）：每次点关闭都弹询问框（最小化到托盘 / 退出程序）；
 * - `minimize`：直接隐藏到托盘，后台继续跑 Agent Host 与后台服务；
 * - `quit`：直接走正常退出流程（`before-quit` → Host 排空 → 回收子进程树）。
 *
 * 存在 `<userData>/close-preference.json`，与 `agentDir/desktop-settings.json`
 * 分开：后者由 Next / Host 读写，而打包后的 Main 进程只有 `electron/dist`，
 * 不能 import `lib/` 里的运行时。
 *
 * 纯函数 + 窄接口：不 import Electron，便于单测。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { dirname } from "path";

export type CloseAction = "ask" | "minimize" | "quit";

export const CLOSE_ACTIONS: readonly CloseAction[] = ["ask", "minimize", "quit"];

export const CLOSE_PREFERENCE_FILENAME = "close-preference.json";

export function isCloseAction(value: unknown): value is CloseAction {
  return value === "ask" || value === "minimize" || value === "quit";
}

/**
 * 未知 / 损坏 / 缺失的值一律回落 `ask`：宁可多问一次，也不要静默退出
 * （用户会丢正在跑的 agent 会话）或静默隐藏（用户以为点了没反应）。
 */
export function parseClosePreference(raw: unknown): CloseAction {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "ask";
  const action = (raw as Record<string, unknown>).closeAction;
  return isCloseAction(action) ? action : "ask";
}

export function readClosePreference(filePath: string): CloseAction {
  if (!existsSync(filePath)) return "ask";
  try {
    return parseClosePreference(JSON.parse(readFileSync(filePath, "utf-8")));
  } catch {
    return "ask";
  }
}

/** 写偏好（先写 `.tmp` 再 rename，避免半截文件让下次启动误判）。 */
export function writeClosePreference(filePath: string, action: CloseAction): CloseAction {
  const next: CloseAction = isCloseAction(action) ? action : "ask";
  const body = `${JSON.stringify({ version: 1, closeAction: next }, null, 2)}\n`;
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, body);
  try {
    renameSync(tmp, filePath);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* 清理失败不影响主流程 */
    }
    throw error;
  }
  return next;
}
