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
});

contextBridge.exposeInMainWorld("electronAPI", {
  selectDirectory: () => ipcRenderer.invoke("select-directory"),
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
});
