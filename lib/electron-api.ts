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
}

export function getElectronApi(): ElectronApi | null {
  if (typeof window === "undefined") return null;
  const api = (window as unknown as { electronAPI?: Partial<ElectronApi> })
    .electronAPI;
  if (!api || typeof api !== "object") return null;
  if (typeof api.selectDirectory !== "function") return null;
  return api as ElectronApi;
}
