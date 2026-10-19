import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell, utilityProcess } from "electron";
import type { UpdateInfo } from "electron-updater";
import path from "path";
import { appendFileSync, existsSync, mkdirSync } from "fs";
import { spawn } from "child_process";
import net from "net";
import { createTray } from "./tray";
import { waitForNextServerReady } from "./server-wait";
import { killProcessDescendants, killProcessTree } from "./process-tree";
import { pickApiKeys } from "./env-filter";
import { choosePort } from "./port-selection";
import { getNextRestartState, type ServerState } from "./restart-policy";
import { getNextCrashReloadState } from "./crash-recovery";
import { loadPageWithRetry } from "./navigation";
import { formatElectronLogLine, deriveScope, type ElectronLogLevel } from "./log-format";
import {
  createUpdateInstallState,
  decideQuitAndInstall,
  markUpdateDownloaded,
  type UpdateInstallState,
} from "./update-install-gate";
import { buildElectronCspHeader } from "./csp";
import { getAppIconPath } from "./app-icon";
import { applyTitleBarOverlayTheme } from "./title-bar-overlay";
import { normalizeWindowPath } from "./window-path";
import {
  ServerProcess,
  wrapChildServerProcess,
  wrapUtilityServerProcess,
} from "./server-process";

// ---------------------------------------------------------------------------
// Single Instance Lock
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

app.on("second-instance", () => {
  const target =
    lastFocusedWindow && !lastFocusedWindow.isDestroyed()
      ? lastFocusedWindow
      : mainWindow && !mainWindow.isDestroyed()
        ? mainWindow
        : null;
  if (target) {
    if (target.isMinimized()) target.restore();
    target.show();
    target.focus();
  } else if (startupUiReady) {
    openNewWindow();
  }
});

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let mainWindow: BrowserWindow | null = null;
let lastFocusedWindow: BrowserWindow | null = null;
const appWindows = new Set<BrowserWindow>();
const windowPaths = new WeakMap<BrowserWindow, string>();
let sessionCspInstalled = false;
let nextProcess: ServerProcess | null = null;
let isQuitting = false;
let logFilePath: string | null = null;
const DEFAULT_PORT = 30141;
let serverState: ServerState = "starting";
let activePort: number | null = null;
let startupUiReady = false;
let restartAttempts: number[] = [];
let updateInstallState: UpdateInstallState = createUpdateInstallState();

export function setQuitting(val: boolean) {
  isQuitting = val;
}
export function getQuitting(): boolean {
  return isQuitting;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function getLogFilePath(): string {
  if (!logFilePath) {
    const logDir = app.getPath("logs");
    mkdirSync(logDir, { recursive: true });
    logFilePath = path.join(logDir, "main.log");
  }
  return logFilePath;
}

function writeLog(level: ElectronLogLevel, message: string, detail?: unknown) {
  try {
    appendFileSync(
      getLogFilePath(),
      formatElectronLogLine({ level, source: "electron-main", scope: deriveScope(message), message, detail }),
      "utf8",
    );
  } catch {
    // Avoid failing app startup because diagnostics cannot be written.
  }
}

function logInfo(message: string, detail?: unknown) {
  console.log(message, detail ?? "");
  writeLog("info", message, detail);
}

function logError(message: string, detail?: unknown) {
  console.error(message, detail ?? "");
  writeLog("error", message, detail);
}

function startupPageUrl(state: "starting" | "error" | "stopped", message?: string): string {
  const url = new URL(`file://${path.join(__dirname, "startup.html").replace(/\\/g, "/")}`);
  const hash = new URLSearchParams({ state });
  if (message) {
    hash.set("message", message);
  }
  url.hash = hash.toString();
  return url.toString();
}

function showStartupStateFor(window: BrowserWindow, state: "starting" | "error" | "stopped", message?: string) {
  if (window.isDestroyed()) {
    return;
  }
  void window.loadURL(startupPageUrl(state, message)).catch((err: unknown) => {
    // A newer navigation (e.g. the app URL right after opening a window) can
    // abort the startup page load; that is expected and not an error.
    if (err instanceof Error && err.message.includes("ERR_ABORTED")) {
      return;
    }
    logError("Failed to load startup page", err);
  });
}

function showStartupState(state: "starting" | "error" | "stopped", message?: string) {
  for (const window of appWindows) {
    showStartupStateFor(window, state, message);
  }
}

let startupStartedAt = Date.now();

function logStartupTiming(stage: string, detail?: unknown) {
  logInfo(`Startup timing: ${stage}`, { elapsedMs: Date.now() - startupStartedAt, detail });
}

// ---------------------------------------------------------------------------
// Port finding
// ---------------------------------------------------------------------------
function reservePort(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      server.close(() => resolve(addr && typeof addr === "object" ? addr.port : port));
    });
    server.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Next.js server lifecycle
// ---------------------------------------------------------------------------
function startNextServer(port: number): ServerProcess {
  const isDev = !app.isPackaged;

  if (isDev) {
    // Dev: use 'node' (not process.execPath which is electron.exe) to start next dev
    const nextBin = require.resolve("next/dist/bin/next", { paths: [app.getAppPath()] });
    const proc = spawn("node", [nextBin, "dev", "-p", String(port)], {
      cwd: app.getAppPath(),
      env: {
        ...pickApiKeys(process.env),
        NODE_ENV: process.env.NODE_ENV ?? "development",
        PORT: String(port),
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: "pipe",
    });
    return monitorNextServerProcess(
      wrapChildServerProcess(proc, killProcessTree),
      "Next.js dev server",
    );
  }

  // Production: macOS uses a background Electron utility process so the
  // server does not appear as a second bouncing app in the Dock. Other
  // platforms retain the ELECTRON_RUN_AS_NODE standalone path.
  const standaloneDir = path.join(process.resourcesPath, "standalone");
  const serverScript = path.join(standaloneDir, "server.js");
  const serverEnv = {
    ...pickApiKeys(process.env),
    NODE_ENV: process.env.NODE_ENV ?? "production",
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
  };
  const proc = process.platform === "darwin"
    ? (() => {
        const utility = utilityProcess.fork(serverScript, [], {
          cwd: standaloneDir,
          env: serverEnv,
          stdio: "pipe",
          serviceName: "Pi Agent Next Server",
        });
        return wrapUtilityServerProcess(utility, (process) => {
          const pid = process.pid;
          const descendantError = pid
            ? killProcessDescendants(pid, "SIGKILL")
            : null;
          process.kill();
          return descendantError;
        });
      })()
    : wrapChildServerProcess(
        spawn(process.execPath, [serverScript], {
          cwd: standaloneDir,
          env: {
            ...serverEnv,
            ELECTRON_RUN_AS_NODE: "1",
          },
          stdio: "pipe",
        }),
        killProcessTree,
      );
  logInfo("Starting packaged Next.js server", { standaloneDir, serverScript, port });
  return monitorNextServerProcess(proc, "Packaged Next.js server");
}

function monitorNextServerProcess(proc: ServerProcess, label: string): ServerProcess {
  proc.stdout?.on("data", (d: Buffer) => logInfo(`[Next] ${d.toString().trim()}`));
  proc.stderr?.on("data", (d: Buffer) => logError(`[Next] ${d.toString().trim()}`));
  proc.on("exit", (code, signal) => handleNextProcessExit(label, code, signal));
  proc.on("error", (err) => handleNextProcessError(label, err));
  return proc;
}

async function restartNextServer(label: string) {
  const nextRestart = getNextRestartState({ now: Date.now(), attempts: restartAttempts, serverState, isQuitting });
  restartAttempts = nextRestart.attempts;

  if (!nextRestart.shouldRestart) {
    logError("Next.js server exited too often; automatic restart disabled", {
      attempts: nextRestart.attempts,
      windowMs: 60_000,
      label,
    });
    serverState = "stopped";
    showStartupState("stopped", `${label} 已退出`);
    return;
  }

  try {
    serverState = "starting";
    activePort = null;
    showStartupState("starting", "正在重新启动本地服务");
    const port = await choosePort({ startPort: DEFAULT_PORT, reservePort });
    activePort = port;
    nextProcess = startNextServer(port);
    await waitForNextServerReady(port, nextProcess, { requireHttpHealth: app.isPackaged });
    await showApp(port);
  } catch (err) {
    logError("Failed to restart Next.js server", err);
    serverState = "stopped";
    cleanup();
    activePort = null;
    showStartupState("stopped", "本地服务重启失败");
  }
}

function handleNextProcessExit(label: string, code: number | null, signal: NodeJS.Signals | null) {
  logInfo(`${label} exited`, { code, signal, serverState, isQuitting });

  if (isQuitting || serverState === "stopped") {
    return;
  }

  nextProcess = null;

  if (serverState === "starting") {
    serverState = "stopped";
    showStartupState("error", "本地服务启动失败");
    return;
  }

  void restartNextServer(label);
}

function handleNextProcessError(label: string, err: Error) {
  logError(`${label} process error`, err);

  if (isQuitting || serverState === "stopped") {
    return;
  }

  nextProcess = null;

  if (serverState === "starting") {
    serverState = "stopped";
    showStartupState("error", err.message);
    return;
  }

  void restartNextServer(label);
}

function cleanup() {
  const proc = nextProcess;
  nextProcess = null;

  if (proc && !proc.killed) {
    logInfo("Killing Next.js server process");
    const error = proc.terminate();
    if (error) {
      logError("Failed to kill Next.js server process tree", error);
    }
  }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createWindow(options: { initialPath?: string; showStartup?: boolean } = {}): BrowserWindow {
  const initialPath = normalizeWindowPath(options.initialPath);
  const showStartup = options.showStartup ?? true;
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#0c1118",       // --bg-elevated (dark)
      symbolColor: "#d9deea", // --text (dark)
      height: 36,
    },
    title: "PiForge",
    icon: nativeImage.createFromPath(getAppIconPath(app.getAppPath())),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      // Electron 官方强烈推荐启用 sandbox：显著缩小渲染进程攻击面。
      // preload 只用 contextBridge + ipcRenderer.{on,off,invoke,send}，
      // 这些 API 在 sandbox 模式下都可用，不会破坏功能。
      sandbox: true,
    },
  });

  appWindows.add(window);
  windowPaths.set(window, initialPath);
  if (!mainWindow) {
    mainWindow = window;
  }
  lastFocusedWindow = window;

  installNavigationGuards(window);
  installCrashRecovery(window);

  // Inject a Content-Security-Policy header into every response loaded in the
  // app. Next.js does not emit CSP on its own, so without this a single XSS
  // (e.g. from a compromised npm package or local route) could drive the
  // preload-exposed electronAPI (quitAndInstall, select directory, ...). The
  // port is re-read on every callback so restarts / port switches pick up the
  // new value automatically. Policy builder mirrors lib/csp.ts (see
  // electron/csp.ts). startup.html ships its own stricter CSP via a meta tag
  // and is unaffected. All windows share the default session, so install the
  // hook once.
  if (!sessionCspInstalled) {
    sessionCspInstalled = true;
    window.webContents.session.webRequest.onHeadersReceived((details, callback) => {
      const port = activePort ?? 0;
      const csp = buildElectronCspHeader(port);
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [csp],
        },
      });
    });
  }

  if (showStartup) {
    showStartupStateFor(window, "starting");
  }

  window.once("ready-to-show", () => {
    window.show();
  });

  window.on("focus", () => {
    lastFocusedWindow = window;
  });

  // The primary window hides to the tray (tray app behaviour). Extra project
  // windows close normally so they do not accumulate as invisible windows.
  window.on("close", (e) => {
    if (!isQuitting && window === mainWindow) {
      e.preventDefault();
      window.hide();
    }
  });

  window.on("closed", () => {
    appWindows.delete(window);
    if (lastFocusedWindow === window) {
      lastFocusedWindow = null;
    }
    if (mainWindow === window) {
      startupUiReady = false;
      mainWindow = [...appWindows].find((candidate) => !candidate.isDestroyed()) ?? null;
    }
  });

  return window;
}

async function loadAppUrl(window: BrowserWindow, port: number, appPath: string): Promise<void> {
  const proc = nextProcess;
  if (!proc) {
    throw new Error("Next.js server process unavailable while loading app URL");
  }
  if (window.isDestroyed()) {
    throw new Error("App window unavailable while loading app URL");
  }

  const navigationAbort = new AbortController();
  const abortForProcessExit = () => {
    navigationAbort.abort(new Error("App navigation cancelled: Next.js server process exited"));
  };
  const abortForWindowClose = () => {
    navigationAbort.abort(new Error("App navigation cancelled: app window was destroyed"));
  };
  const abortForQuit = () => {
    navigationAbort.abort(new Error("App navigation cancelled: application is quitting"));
  };
  proc.once("exit", abortForProcessExit);
  proc.once("error", abortForProcessExit);
  window.once("closed", abortForWindowClose);
  app.once("before-quit", abortForQuit);

  const assertCurrentNavigation = () => {
    if (isQuitting) {
      throw new Error("App navigation cancelled: application is quitting");
    }
    if (window.isDestroyed()) {
      throw new Error("App navigation cancelled: app window was destroyed");
    }
    if (nextProcess !== proc) {
      throw new Error("App navigation cancelled: Next.js server process changed");
    }
    if (proc.exitCode !== null) {
      throw new Error("App navigation cancelled: Next.js server process exited");
    }
    if (serverState !== "starting" && serverState !== "ready") {
      throw new Error(`App navigation cancelled from server state: ${serverState}`);
    }
  };

  try {
    await loadPageWithRetry(
      `http://127.0.0.1:${port}${appPath}`,
      async (url) => {
        assertCurrentNavigation();
        await window.loadURL(url);
      },
      {
        signal: navigationAbort.signal,
        cancelAttempt: () => {
          if (!window.isDestroyed()) {
            window.webContents.stop();
          }
        },
        shouldRetry: () => {
          try {
            assertCurrentNavigation();
            return true;
          } catch {
            return false;
          }
        },
      }
    );
  } finally {
    proc.off("exit", abortForProcessExit);
    proc.off("error", abortForProcessExit);
    window.off("closed", abortForWindowClose);
    app.off("before-quit", abortForQuit);
  }
  assertCurrentNavigation();
}

async function showApp(port: number): Promise<void> {
  activePort = port;
  logStartupTiming("loading app url", { port });
  const windows = [...appWindows].filter((window) => !window.isDestroyed());
  if (windows.length === 0) {
    throw new Error("No app window available while loading app URL");
  }
  if (!nextProcess) {
    throw new Error("Next.js server process unavailable while loading app URL");
  }

  for (const window of windows) {
    await loadAppUrl(window, port, windowPaths.get(window) ?? "/");
  }
  serverState = "ready";
}

/**
 * Opens an additional project window against the shared local server.
 * The new window starts on `path` (usually `/?cwd=...`) and keeps the primary
 * window untouched, so two projects can be visible side by side.
 */
function openNewWindow(path?: string): BrowserWindow {
  const serverReady =
    serverState === "ready" && Boolean(activePort) && Boolean(nextProcess) && nextProcess?.exitCode === null;
  const window = createWindow({ initialPath: path, showStartup: !serverReady });
  if (serverReady && activePort) {
    void loadAppUrl(window, activePort, windowPaths.get(window) ?? "/").catch((err: unknown) => {
      logError("Failed to load app URL in new window", err);
      showStartupStateFor(window, "error", err instanceof Error ? err.message : String(err));
    });
  }
  return window;
}

function isAllowedAppUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);

    if (parsed.protocol === "file:") {
      return parsed.pathname.endsWith("/startup.html");
    }

    return parsed.protocol === "http:" && parsed.hostname === "127.0.0.1" && parsed.port === String(activePort);
  } catch {
    return false;
  }
}

// Recover from renderer process crashes: without a handler here the window
// stays blank forever after the renderer dies (OOM, GPU crash, ...).
// Auto-reload is bounded by crash-recovery.ts to avoid crash loops.
function installCrashRecovery(window: BrowserWindow) {
  let reloadAttempts: number[] = [];
  window.webContents.on("render-process-gone", (_event, details) => {
    logError("Renderer process gone", details);
    const next = getNextCrashReloadState({
      now: Date.now(),
      reason: details.reason,
      attempts: reloadAttempts,
      isQuitting,
    });
    reloadAttempts = next.attempts;
    if (!next.shouldReload) {
      logError("Renderer crash auto-reload skipped", { reason: details.reason });
      // 达到自动 reload 上限后窗口会一直白屏；复用 startup.html 给出可见提示
      // （与 server 退出路径的 showStartupState("stopped", …) 兜底一致）。
      // clean-exit / isQuitting 属于正常退出流程，不应展示"已停止"错误页；
      // 纯函数对这两种情况在达到上限判断之前就直接返回 false，因此这里的
      // 条件恰好只命中"崩溃次数达上限"这一种情况。
      if (details.reason !== "clean-exit" && !isQuitting && !window.isDestroyed()) {
        showStartupState("stopped", "页面多次崩溃，已停止自动恢复");
      }
      return;
    }
    if (window.isDestroyed()) {
      return;
    }
    logInfo("Reloading renderer after crash");
    window.webContents.reload();
  });
}

function installNavigationGuards(window: BrowserWindow) {
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedAppUrl(url)) {
      event.preventDefault();
      logError("Blocked navigation", { url });
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      void shell.openExternal(url).catch((err) => logError("Failed to open external URL", err));
    } else {
      logError("Blocked window open", { url });
    }
    return { action: "deny" };
  });
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------
function registerIpcHandlers() {
  ipcMain.handle("select-directory", async () => {
    const targetWindow = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined;
    const result = targetWindow
      ? await dialog.showOpenDialog(targetWindow, {
          properties: ["openDirectory"],
        })
      : await dialog.showOpenDialog({
          properties: ["openDirectory"],
        });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle("new-window", async (_event, requestedPath: unknown) => {
    openNewWindow(normalizeWindowPath(requestedPath));
    return { ok: true };
  });

  ipcMain.handle("quit-and-install", async () => {
    logInfo("quitAndInstall requested from renderer");
    const decision = decideQuitAndInstall(updateInstallState);
    if (!decision.allowed) {
      logInfo("quitAndInstall refused", { reason: decision.reason });
      return { ok: false, error: decision.reason };
    }
    setQuitting(true);
    const { autoUpdater } = await import("electron-updater");
    autoUpdater.quitAndInstall();
    return { ok: true, version: decision.version };
  });

  ipcMain.on("set-theme", (event, theme: unknown) => {
    const target = BrowserWindow.fromWebContents(event.sender);
    applyTitleBarOverlayTheme(target, theme);
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
// Observability only: record child process deaths (GPU, utility, ...).
// No auto-reload here — Electron already falls back to software rendering
// when the GPU process dies, and blindly reloading risks crash loops;
// renderer crashes have their own bounded recovery in installCrashRecovery.
app.on("child-process-gone", (_event, details) => {
  logError("Child process gone", {
    type: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
  });
});

app.on("before-quit", () => {
  logInfo("before-quit");
  isQuitting = true;
  cleanup();
});

app.on("window-all-closed", () => {
  // Do nothing — keep running in tray
});

app.on("activate", () => {
  const target =
    lastFocusedWindow && !lastFocusedWindow.isDestroyed()
      ? lastFocusedWindow
      : mainWindow;
  if (target) {
    target.show();
    target.focus();
  }
});

app.whenReady().then(async () => {
  startupStartedAt = Date.now();
  logStartupTiming("app ready");
  registerIpcHandlers();

  try {
    const port = await choosePort({ startPort: DEFAULT_PORT, reservePort });
    logStartupTiming("port selected", { port });
    serverState = "starting";
    activePort = port;
    logInfo(`Using port ${port}`);

    createWindow();
    logStartupTiming("window created");
    createTray(mainWindow!, { onNewWindow: () => { openNewWindow(); } });
    startupUiReady = true;

    nextProcess = startNextServer(port);
    logStartupTiming("next process spawned");
    logInfo("Waiting for Next.js server...");

    await waitForNextServerReady(port, nextProcess, { requireHttpHealth: app.isPackaged });
    logStartupTiming("next server ready");
    logInfo("Next.js server is ready");
    await showApp(port);

    // Auto-update check (production only, delayed 30s). Without an update feed
    // electron-builder emits no app-update.yml; skip the check instead of
    // letting electron-updater reject on a missing config file.
    if (app.isPackaged && existsSync(path.join(process.resourcesPath, "app-update.yml"))) {
      setTimeout(async () => {
        try {
          const { autoUpdater } = await import("electron-updater");
          // 不自动下载：让用户决定是否下载（避免流量敏感环境静默下载大文件，
          // 也避免渲染进程 XSS 触发 quitAndInstall 路径）。
          autoUpdater.autoDownload = false;
          logInfo("Checking for updates");

          // Forward update events to renderer
          autoUpdater.on("checking-for-update", () => {
            logInfo("autoUpdater checking-for-update");
          });

          autoUpdater.on("update-available", (info: UpdateInfo) => {
            logInfo("autoUpdater update-available", info);
            // Notify renderer (if window is alive) for in-app banner
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send("update-available", { version: info.version });
            }
            // 弹 dialog 问用户是否下载（因为 autoDownload=false）
            // Fallback dialog: works with or without a parent window（与 update-downloaded 一致）
            const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
            const options = {
              type: "info" as const,
              title: "Update Available",
              message: `A new version (${info.version}) is available.`,
              detail: "Download and install now? The app will restart after download completes.",
              buttons: ["Download", "Later"],
              defaultId: 0,
              cancelId: 1,
            };
            const dialogPromise = parent
              ? dialog.showMessageBox(parent, options)
              : dialog.showMessageBox(options);
            dialogPromise
              .then(({ response }) => {
                logInfo("Update download dialog response", { response });
                if (response === 0) {
                  autoUpdater.downloadUpdate().catch((err: unknown) => {
                    logError(
                      "Auto-update download failed",
                      err instanceof Error ? err : new Error(String(err))
                    );
                  });
                }
              })
              .catch((err: unknown) => {
                logError(
                  "Update dialog failed",
                  err instanceof Error ? err : new Error(String(err))
                );
              });
          });

          autoUpdater.on("update-not-available", (info: UpdateInfo) => {
            logInfo("autoUpdater update-not-available", info);
          });

          autoUpdater.on("download-progress", (info) => {
            logInfo("autoUpdater download-progress", {
              percent: info.percent,
              transferred: info.transferred,
              total: info.total,
            });
          });

          autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
            logInfo("autoUpdater update-downloaded", info);
            updateInstallState = markUpdateDownloaded(updateInstallState, info.version);
            mainWindow?.webContents.send("update-downloaded", { version: info.version });
            // mainWindow 可能已被销毁（用户关闭到托盘后退出）；fallback 到无父窗口版本
            // 让用户仍能看到提示，而非抛 "Cannot read properties of null"。
            const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
            const options = {
              type: "info" as const,
              title: "Update Downloaded",
              message: `Version ${info.version} has been downloaded. Restart to install the update.`,
              buttons: ["Restart Now", "Later"],
              defaultId: 0,
            };
            const showPromise = parent
              ? dialog.showMessageBox(parent, options)
              : dialog.showMessageBox(options);
            showPromise
              .then(({ response }) => {
                logInfo("Update restart dialog response", { response });
                if (response === 0) {
                  setQuitting(true);
                  logInfo("Calling autoUpdater.quitAndInstall");
                  autoUpdater.quitAndInstall();
                }
              })
              .catch((err: unknown) => {
                logError(
                  "Update restart dialog failed",
                  err instanceof Error ? err : new Error(String(err))
                );
              });
          });

          autoUpdater.on("error", (err) => {
            logError("autoUpdater error", err);
          });

          autoUpdater.checkForUpdates();
        } catch (err) {
          logError("Auto-update check failed:", err);
        }
      }, 30_000);
    }
  } catch (err) {
    serverState = "stopped";
    cleanup();
    activePort = null;
    const message = err instanceof Error ? err.message : String(err);
    logError("Failed to start:", err);

    if (startupUiReady) {
      showStartupState("error", message);
      return;
    }

    dialog.showErrorBox("启动失败", message);
    app.quit();
  }
});
