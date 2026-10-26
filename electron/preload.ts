import type { IpcRendererEvent } from "electron";
import { contextBridge, ipcRenderer, webUtils } from "electron";

const preloadPage = globalThis as typeof globalThis & {
  addEventListener?: (event: string, listener: () => void) => void;
  document?: {
    documentElement?: {
      dataset: Record<string, string | undefined>;
    };
  };
};

preloadPage.addEventListener?.("DOMContentLoaded", () => {
  const dataset = preloadPage.document?.documentElement?.dataset;
  if (dataset) {
    dataset.electronPlatform = process.platform;
  }
  syncWindowHidden();
});

/**
 * 窗口隐藏/被完全遮挡时给 <html> 打标记，CSS 据此暂停装饰性动画。
 *
 * 只靠背景节流不够：`animation: ... infinite` 的呼吸点/心跳条即使窗口在托盘里
 * 也会继续合成；0.9.0 实测空闲渲染进程 105% CPU 主要就是它们 + 每秒轮询。
 */
function syncWindowHidden() {
  // Electron 的 preload 不加载 DOM lib（electron/tsconfig.json 只有 ES2022），
  // 这里沿用文件顶部 preloadPage 的"结构性类型"避让方式。
  const page = globalThis as typeof globalThis & {
    document?: { visibilityState?: string; documentElement?: { dataset: Record<string, string | undefined> } };
    addEventListener?: (event: string, listener: () => void) => void;
  };
  const root = page.document?.documentElement;
  if (!root) return;
  root.dataset.windowHidden = page.document?.visibilityState === "hidden" ? "true" : "false";
}

(preloadPage as typeof preloadPage & { addEventListener?: (event: string, listener: () => void) => void })
  .addEventListener?.("visibilitychange", syncWindowHidden);

contextBridge.exposeInMainWorld("electronAPI", {
  selectDirectory: () => ipcRenderer.invoke("select-directory"),
  /** 文件树右键菜单「在资源管理器中显示」；浏览器 dev 版没有这个 bridge。 */
  revealPath: (target: string) => ipcRenderer.invoke("files:reveal", target),
  /** Resolve a drag-dropped File to its absolute filesystem path (Electron only). */
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  onUpdateAvailable: (callback: (info: { version: string }) => void) => {
    const listener = (_event: IpcRendererEvent, info: { version: string }) => callback(info);
    ipcRenderer.on("update-available", listener);
    return () => ipcRenderer.off("update-available", listener);
  },
  onUpdateDownloaded: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("update-downloaded", listener);
    return () => ipcRenderer.off("update-downloaded", listener);
  },
  quitAndInstall: () => ipcRenderer.invoke("quit-and-install"),
  /** pi 核心版本切换：选版本 → npm install → 重启生效。 */
  piCore: {
    install: (version: string) => ipcRenderer.invoke("pi-core:install", version),
    relaunch: () => ipcRenderer.invoke("pi-core:relaunch"),
    onProgress: (callback: (chunk: string) => void) => {
      const listener = (_event: IpcRendererEvent, chunk: string) => callback(chunk);
      ipcRenderer.on("pi-core:progress", listener);
      return () => ipcRenderer.off("pi-core:progress", listener);
    },
  },
  openWindow: (path: string) => ipcRenderer.invoke("new-window", path),
  /** PNG screenshot of a <webview> guest, for the agent's web_preview tool. */
  captureWebview: (webContentsId: number) => ipcRenderer.invoke("capture-webview", webContentsId),
  browserSetBounds: (bounds: { x: number; y: number; width: number; height: number }, visible: boolean) =>
    ipcRenderer.invoke("browser:set-bounds", bounds, visible),
  browserNavigate: (url: string) => ipcRenderer.invoke("browser:navigate", url),
  browserAction: (action: "back" | "forward" | "reload" | "stop") =>
    ipcRenderer.invoke("browser:action", action),
  browserGetState: () => ipcRenderer.invoke("browser:get-state"),
  onBrowserState: (callback: (state: { url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; visible: boolean }) => void) => {
    const listener = (_event: IpcRendererEvent, state: { url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; visible: boolean }) => callback(state);
    ipcRenderer.on("browser:state", listener);
    return () => ipcRenderer.off("browser:state", listener);
  },
  onBrowserAgentOpen: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("browser:agent-open", listener);
    return () => ipcRenderer.off("browser:agent-open", listener);
  },
  setTheme: (theme: "light" | "dark" | "glacier") => ipcRenderer.send("set-theme", theme),
  /**
   * 流式期间关掉背景节流（打字机要按帧走）；流结束/窗口失焦后立刻恢复。
   * 默认 `backgroundThrottling: true`，所以空闲窗口不会再跑满一个核。
   */
  setStreamingThrottle: (enabled: boolean) => ipcRenderer.send("window:streaming-throttle", enabled),
  /** Agent Host 就绪状态（启动早期 UI 用“启动中”而不是“断开”）。 */
  getHostState: () => ipcRenderer.invoke("host-state:get"),
  onHostState: (callback: (state: { state: string; label: string; blocking: boolean }) => void) => {
    const listener = (_event: IpcRendererEvent, state: { state: string; label: string; blocking: boolean }) =>
      callback(state);
    ipcRenderer.on("host-state", listener);
    return () => ipcRenderer.off("host-state", listener);
  },
});
