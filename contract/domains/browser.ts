/**
 * Bridge between the renderer's built-in browser panel and the agent tool
 * `web_preview`. The command queue now lives in the Agent Host.
 */

export type BrowserCommandKind = "read" | "screenshot" | "open";

export interface BrowserCommand {
  id: string;
  kind: BrowserCommandKind;
  /** Only for `open`: absolute http(s) URL. */
  url?: string;
}

export interface BrowserPageSnapshot {
  url: string;
  title: string;
  text: string;
  /** True when `text` had to be clipped before it crossed the bridge. */
  truncated: boolean;
  /** False when the panel renders in a plain browser (iframe fallback). */
  native: boolean;
  webContentsId?: number | null;
  viewport?: { width: number; height: number } | null;
  scrollY?: number;
  updatedAt: number;
}

export interface BrowserCommandResult {
  id: string;
  ok: boolean;
  text?: string;
  url?: string;
  title?: string;
  /** PNG payload for `screenshot` commands (base64, no data: prefix). */
  image?: { data: string; mimeType: string };
  error?: string;
}
