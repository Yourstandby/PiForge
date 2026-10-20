/**
 * Typed access to the preload bridge exposed by `electron/preload.ts`.
 *
 * The renderer runs in both browser (`npm run dev`) and Electron, so every
 * caller has to tolerate the bridge being absent.
 */

export interface ElectronApi {
  /** Native folder picker. Resolves null when the user cancels. */
  selectDirectory: () => Promise<string | null>;
  /** Opens `/?cwd=…` in a new window against the shared local server. */
  openWindow?: (path: string) => Promise<{ ok: boolean } | undefined>;
  /** Resolves a drag-dropped File to its absolute filesystem path. */
  getPathForFile?: (file: File) => string;
  /** PNG screenshot of a `<webview>` guest (main-process capture). */
  captureWebview?: (webContentsId: number) => Promise<{ data: string; mimeType: string } | null>;
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
