/**
 * Typed access to the preload bridge exposed by `electron/preload.ts`.
 *
 * The renderer runs in both browser (`npm run dev`) and Electron, so every
 * caller has to tolerate the bridge being absent.
 */

export interface BrowserState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  visible: boolean;
}

/** 自动更新阶段（Main 主导，Renderer 只读快照）。 */
export type UpdatePhase =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "error"
  | "unsupported";

/** 一次自动更新的完整快照。 */
export interface UpdateSnapshot {
  phase: UpdatePhase;
  /** 目标版本（已发布 / 最新版本号）。 */
  version: string | null;
  /** 下载进度 0-100。 */
  percent: number;
  bytesPerSecond: number;
  /** Main 正在干活（按钮置灰用）。 */
  busy: boolean;
  error: string | null;
}

/** 留档的历史安装包含版本号。 */
export interface UpdateArchive {
  version: string;
  path?: string;
}

/**
 * preload 暴露的自动更新桥。
 *
 * 仅打包版 Electron 存在；dev / 浏览器模式下 `electronAPI.updater` 为 undefined，
 * 调用方（useAppUpdater）据此把 supported 置为 false 并隐藏入口。
 */
export interface UpdaterApi {
  getState: () => Promise<UpdateSnapshot>;
  onState: (callback: (snapshot: UpdateSnapshot) => void) => () => void;
  check: () => Promise<UpdateSnapshot>;
  download: () => Promise<UpdateSnapshot>;
  install: () => Promise<void>;
  rollback: (version: string) => Promise<{ ok: boolean; error?: string }>;
  archives: () => Promise<UpdateArchive[]>;
}

export interface ElectronApi {
  /** Native folder picker. Resolves null when the user cancels. */
  selectDirectory: () => Promise<string | null>;
  /** Opens `/?cwd=…` in a new window against the shared local server. */
  openWindow?: (path: string) => Promise<{ ok: boolean } | undefined>;
  /** Resolves a drag-dropped File to its absolute filesystem path. */
  getPathForFile?: (file: File) => string;
  /** PNG screenshot of a `<webview>` guest (legacy; browser is Main-owned now). */
  captureWebview?: (webContentsId: number) => Promise<{ data: string; mimeType: string } | null>;
  /** Main-owned WebContentsView placement; Renderer only supplies the rect. */
  browserSetBounds?: (bounds: { x: number; y: number; width: number; height: number }, visible: boolean) => Promise<{ ok: boolean }>;
  browserNavigate?: (url: string) => Promise<{ ok: boolean; error?: string; state?: BrowserState }>;
  browserAction?: (action: "back" | "forward" | "reload" | "stop") => Promise<{ ok: boolean; error?: string; state?: BrowserState }>;
  browserGetState?: () => Promise<BrowserState | null>;
  onBrowserState?: (callback: (state: BrowserState) => void) => () => void;
  onBrowserAgentOpen?: (callback: () => void) => () => void;
  setTheme?: (theme: "light" | "dark" | "glacier") => void;
  /** 自动更新桥（打包版才有）。 */
  updater?: UpdaterApi;
}

export function getElectronApi(): ElectronApi | null {
  if (typeof window === "undefined") return null;
  const api = (window as unknown as { electronAPI?: Partial<ElectronApi> })
    .electronAPI;
  if (!api || typeof api !== "object") return null;
  if (typeof api.selectDirectory !== "function") return null;
  return api as ElectronApi;
}
