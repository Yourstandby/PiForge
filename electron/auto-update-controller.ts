/**
 * 自动更新控制器（阶段八第 1 步）：把 electron-updater 的事件、超时、留档、
 * 回退收在一处，`main.ts` 只负责注入依赖与转发 IPC。
 *
 * 刻意不 import electron：`loadUpdater` 由 Main 注入（`app.isPackaged` 判断也在
 * 那边做），所以这层可以用 node:test + 假 updater + tmp 目录完整测。
 *
 * 三条硬约束（对应"点了不能卡半天"）：
 * 1. 点击先切相位再发网络请求 → 渲染侧 100ms 内有反馈。
 * 2. 检查 6s、下载停滞 20s 都判 error，不留无限 spinner。
 * 3. 进度事件节流到 ≥1% 或 ≥400ms，避免刷爆 IPC。
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import {
  archiveFileName,
  createSnapshot,
  parseArchiveVersion,
  reduceUpdate,
  selectArchivesToDelete,
  shouldEmitProgress,
  unsupportedSnapshot,
  UPDATE_CHECK_TIMEOUT_MS,
  UPDATE_STALL_TIMEOUT_MS,
  type UpdateEvent,
  type UpdateSnapshot,
} from "./app-update";

/** electron-updater 的最小面（AppUpdater 的类型化 emitter 不兼容，Main 侧显式断言）。 */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: string, listener: (payload: unknown) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
}

export interface UpdateControllerDeps {
  loadUpdater: () => Promise<UpdaterLike>;
  /** 打包 + 固定更新源存在才允许检查更新。 */
  isSupported: () => boolean;
  broadcast: (snapshot: UpdateSnapshot) => void;
  /** 下载完成：交给 Main 的 install gate 记账。 */
  markDownloaded: (version: string) => void;
  archiveDir: () => string;
  launchInstaller: (installerPath: string) => void;
  quit: () => void;
  log: (message: string, meta?: unknown) => void;
  logError: (message: string, error: unknown) => void;
  checkTimeoutMs?: number;
  stallTimeoutMs?: number;
  archiveKeep?: number;
}

export interface ArchivedUpdate {
  version: string;
  path: string;
  mtimeMs: number;
}

export interface UpdateController {
  getSnapshot(): UpdateSnapshot;
  /** 启动后的延迟检查（只调一次）。 */
  init(): Promise<void>;
  check(): Promise<UpdateSnapshot>;
  download(): Promise<UpdateSnapshot>;
  listArchives(): ArchivedUpdate[];
  rollback(version: string): Promise<{ ok: boolean; error?: string }>;
  dispose(): void;
}

export function createUpdateController(deps: UpdateControllerDeps): UpdateController {
  const checkTimeoutMs = deps.checkTimeoutMs ?? UPDATE_CHECK_TIMEOUT_MS;
  const stallTimeoutMs = deps.stallTimeoutMs ?? UPDATE_STALL_TIMEOUT_MS;
  const archiveKeep = deps.archiveKeep ?? 3;

  let snapshot: UpdateSnapshot = createSnapshot();
  let updater: UpdaterLike | null = null;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function broadcast(next: UpdateSnapshot): void {
    snapshot = next;
    deps.broadcast(next);
  }

  function dispatch(event: UpdateEvent): void {
    const prev = snapshot;
    const next = reduceUpdate(prev, event);
    if (next === prev) return;
    if (event.type === "download-progress" && !shouldEmitProgress(prev, next)) {
      // 节流：数据前进但保住 changedAt，让下一个窗口继续累积时间差。
      snapshot = { ...next, changedAt: prev.changedAt };
      return;
    }
    broadcast(next);
  }

  function clearStallTimer(): void {
    if (stallTimer) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  }

  function armStallTimer(): void {
    clearStallTimer();
    stallTimer = setTimeout(() => {
      stallTimer = null;
      dispatch({
        type: "error",
        message: "下载停滞超过 20 秒（网络中断？），可重试",
        at: Date.now(),
      });
    }, stallTimeoutMs);
  }

  function attach(target: UpdaterLike): void {
    target.on("checking-for-update", () => {
      deps.log("autoUpdater checking-for-update");
      dispatch({ type: "check-start", at: Date.now() });
    });

    target.on("update-available", (payload) => {
      const version = (payload as { version?: string } | null)?.version ?? "";
      deps.log("autoUpdater update-available", { version });
      dispatch({ type: "available", version, at: Date.now() });
    });

    target.on("update-not-available", (payload) => {
      const version = (payload as { version?: string } | null)?.version ?? null;
      deps.log("autoUpdater update-not-available", { version });
      dispatch({ type: "not-available", version, at: Date.now() });
    });

    target.on("download-progress", (payload) => {
      const progress = (payload ?? {}) as {
        percent?: number;
        bytesPerSecond?: number;
        total?: number;
      };
      armStallTimer();
      dispatch({
        type: "download-progress",
        percent: progress.percent ?? 0,
        bytesPerSecond: progress.bytesPerSecond ?? 0,
        totalBytes: progress.total ?? 0,
        at: Date.now(),
      });
    });

    target.on("update-downloaded", (payload) => {
      const event = (payload ?? {}) as { version?: string; downloadedFile?: string };
      const version = event.version ?? snapshot.version ?? "";
      deps.log("autoUpdater update-downloaded", { version });
      deps.markDownloaded(version);
      clearStallTimer();
      dispatch({ type: "downloaded", version, at: Date.now() });
      void archive(version, event.downloadedFile);
    });

    target.on("error", (payload) => {
      const error = payload instanceof Error ? payload : new Error(String(payload));
      deps.logError("autoUpdater error", error);
      clearStallTimer();
      dispatch({ type: "error", message: error.message, at: Date.now() });
    });
  }

  async function init(): Promise<void> {
    if (disposed) return;
    if (!deps.isSupported()) {
      snapshot = unsupportedSnapshot(snapshot.changedAt);
      return;
    }
    try {
      const loaded = await deps.loadUpdater();
      // 不自动下载：点「升级」才是用户确认；退出时安装，避免打断会话。
      loaded.autoDownload = false;
      loaded.autoInstallOnAppQuit = true;
      updater = loaded;
      attach(loaded);
      dispatch({ type: "check-start", at: Date.now() });
      void loaded.checkForUpdates().catch((err: unknown) => {
        deps.logError("autoUpdater checkForUpdates failed", err);
        dispatch({
          type: "error",
          message: "检查更新失败（无法连接更新服务器）",
          at: Date.now(),
        });
      });
    } catch (err) {
      deps.logError("Auto-update init failed", err);
      dispatch({ type: "error", message: "自动更新不可用", at: Date.now() });
    }
  }

  async function check(): Promise<UpdateSnapshot> {
    if (disposed) return deps.isSupported() ? snapshot : unsupportedSnapshot();
    if (!deps.isSupported()) {
      return unsupportedSnapshot(Date.now());
    }
    if (!updater) {
      await init();
      return snapshot;
    }
    dispatch({ type: "check-start", at: Date.now() });
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        updater.checkForUpdates(),
        new Promise<void>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("update check timeout")), checkTimeoutMs);
        }),
      ]);
    } catch (err) {
      const timedOut = err instanceof Error && err.message === "update check timeout";
      dispatch({
        type: "error",
        message: timedOut
          ? "检查超时（6 秒），网络不通"
          : "检查更新失败（无法连接更新服务器）",
        at: Date.now(),
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
    return snapshot;
  }

  async function download(): Promise<UpdateSnapshot> {
    if (disposed || !deps.isSupported()) return snapshot;
    if (!updater) await init();
    if (!updater || snapshot.phase === "downloading") return snapshot;
    // 点击即确认：先切相位，UI 不用等第一个字节。
    dispatch({ type: "download-start", at: Date.now() });
    armStallTimer();
    try {
      await updater.downloadUpdate();
    } catch (err) {
      clearStallTimer();
      deps.logError("autoUpdater downloadUpdate failed", err);
      dispatch({ type: "error", message: "下载失败，请重试", at: Date.now() });
    }
    return snapshot;
  }

  function listArchives(): ArchivedUpdate[] {
    const dir = deps.archiveDir();
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => {
          const full = path.join(dir, entry.name);
          return {
            version: parseArchiveVersion(entry.name),
            path: full,
            mtimeMs: statSync(full).mtimeMs,
          };
        })
        .filter((entry): entry is ArchivedUpdate => entry.version !== null)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
    } catch {
      return [];
    }
  }

  /** 下载完成后留档（默认最多 3 份），降级时重装旧包。 */
  async function archive(version: string, downloadedFile?: string): Promise<void> {
    if (!version || !downloadedFile || !existsSync(downloadedFile)) return;
    try {
      const dir = deps.archiveDir();
      mkdirSync(dir, { recursive: true });
      const target = path.join(dir, archiveFileName(version));
      if (!existsSync(target)) copyFileSync(downloadedFile, target);
      const entries = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => ({
          name: entry.name,
          mtimeMs: statSync(path.join(dir, entry.name)).mtimeMs,
        }));
      for (const name of selectArchivesToDelete(entries, archiveKeep)) {
        try {
          rmSync(path.join(dir, name), { force: true });
        } catch {
          // 清理失败不影响更新本身
        }
      }
    } catch (err) {
      deps.logError("留档安装包失败", err);
    }
  }

  /**
   * 回退：拉起留档安装包后退出。数据（~/.pi、会话、LTM）不参与安装，回退不动数据。
   */
  async function rollback(version: string): Promise<{ ok: boolean; error?: string }> {
    const target = listArchives().find((entry) => entry.version === version);
    if (!target) return { ok: false, error: "未找到该版本的留档安装包" };
    deps.log("Rolling back to archived installer", { version, path: target.path });
    try {
      deps.launchInstaller(target.path);
    } catch (err) {
      deps.logError("回退安装器启动失败", err);
      return { ok: false, error: "无法启动留档安装包" };
    }
    setTimeout(() => {
      if (!disposed) deps.quit();
    }, 500);
    return { ok: true };
  }

  return {
    getSnapshot: () => (deps.isSupported() ? snapshot : unsupportedSnapshot(snapshot.changedAt)),
    init,
    check,
    download,
    listArchives,
    rollback,
    dispose: () => {
      disposed = true;
      clearStallTimer();
    },
  };
}
