/**
 * Main-owned shared browser (v0.6.0 stage 9 step 2).
 *
 * The renderer owns only a DOM placeholder; the real WebContentsView lives in
 * Electron Main. Host commands arrive over the named-pipe RPC bridge and are
 * executed here, never in Next.
 */
// Keep the Electron project self-contained: importing contract/ would break
// the electron tsconfig rootDir. These shapes mirror contract/domains/browser.
export type BrowserCommandKind = "read" | "screenshot" | "open" | "back" | "forward" | "reload";
export interface BrowserCommand {
  id: string;
  kind: BrowserCommandKind;
  url?: string;
  windowId?: string;
  ownerId?: string;
}
export interface BrowserCommandResult {
  id: string;
  ok: boolean;
  text?: string;
  url?: string;
  title?: string;
  image?: { data: string; mimeType: string };
  error?: string;
  code?: string;
  ready?: boolean;
  boundsGeneration?: number;
}
export interface BrowserPageSnapshot {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
  native: boolean;
  webContentsId?: number | null;
  viewport?: { width: number; height: number } | null;
  scrollY?: number;
  ready?: boolean;
  boundsGeneration?: number;
  windowId?: string;
  ownerId?: string;
  updatedAt: number;
}

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserPageContents {
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  executeJavaScript(code: string): Promise<unknown>;
  capturePage(): Promise<{ toPNG(): Uint8Array; isEmpty?(): boolean }>;
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
  isDestroyed?(): boolean;
  setWindowOpenHandler?(handler: (details: { url: string }) => { action: "deny" | "allow" }): void;
  setBackgroundThrottling?(enabled: boolean): void;
}

export interface BrowserSurface {
  webContents: BrowserPageContents;
  setBounds(bounds: BrowserBounds): void;
  setVisible(visible: boolean): void;
  close?(): void;
}

export interface BrowserState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  visible: boolean;
  ready: boolean;
  boundsGeneration: number;
}

export interface BrowserManagerOptions {
  createSurface: () => BrowserSurface;
  isAllowedUrl?: (url: string) => boolean;
}

const SNAPSHOT_SCRIPT = `(() => {
  const body = document.body ? document.body.innerText || "" : "";
  return { text: body.slice(0, 200000), url: location.href, title: document.title, scrollY: window.scrollY || 0, width: window.innerWidth || 0, height: window.innerHeight || 0 };
})()`;

export function isAllowedBrowserUrl(raw: string): boolean {
  if (raw === "about:blank") return true;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeBounds(bounds: BrowserBounds): BrowserBounds {
  const clean = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0);
  return {
    x: clean(bounds.x),
    y: clean(bounds.y),
    width: clean(bounds.width),
    height: clean(bounds.height),
  };
}

export class BrowserManager {
  private surface: BrowserSurface | null = null;
  private visible = false;
  private loading = false;
  private ready = false;
  private boundsGeneration = 0;
  private bounds: BrowserBounds = { x: 0, y: 0, width: 0, height: 0 };
  private listeners = new Set<(state: BrowserState) => void>();
  private readonly isAllowedUrl: (url: string) => boolean;

  private readonly options: BrowserManagerOptions;

  constructor(options: BrowserManagerOptions) {
    this.options = options;
    this.isAllowedUrl = options.isAllowedUrl ?? isAllowedBrowserUrl;
  }

  /** Lazily create the Main-owned view on first use. */
  private ensureSurface(): BrowserSurface {
    if (this.surface) return this.surface;
    const surface = this.options.createSurface();
    this.surface = surface;
    const contents = surface.webContents;

    const emit = () => this.emitState();
    contents.on("did-start-loading", () => {
      this.loading = true;
      this.ready = false;
      this.emitState();
    });
    contents.on("did-finish-load", () => {
      this.ready = true;
      this.emitState();
    });
    contents.on("did-stop-loading", () => {
      this.loading = false;
      this.emitState();
    });
    for (const event of [
      "did-start-loading",
      "did-stop-loading",
      "did-navigate",
      "did-navigate-in-page",
      "page-title-updated",
      "did-fail-load",
    ]) {
      contents.on(event, emit);
    }
    contents.on("did-navigate", (...args) => {
      const url = typeof args[1] === "string" ? args[1] : contents.getURL();
      if (url && !this.isAllowedUrl(url)) {
        void contents.loadURL("about:blank").catch(() => undefined);
      }
    });
    contents.setWindowOpenHandler?.(({ url }) => {
      if (this.isAllowedUrl(url)) void contents.loadURL(url).catch(() => undefined);
      return { action: "deny" };
    });
    contents.setBackgroundThrottling?.(false);
    surface.setBounds(this.bounds);
    surface.setVisible(this.visible);
    this.emitState();
    return surface;
  }

  onStateChange(listener: (state: BrowserState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): BrowserState {
    const contents = this.surface?.webContents;
    return {
      url: contents?.getURL() ?? "",
      title: contents?.getTitle() ?? "",
      loading: this.loading,
      canGoBack: contents?.canGoBack() ?? false,
      canGoForward: contents?.canGoForward() ?? false,
      visible: this.visible,
      ready: this.ready,
      boundsGeneration: this.boundsGeneration,
    };
  }

  setBounds(bounds: BrowserBounds, visible = this.visible): void {
    const next = normalizeBounds(bounds);
    const valid = next.width > 0 && next.height > 0;
    const changed = valid && (
      next.x !== this.bounds.x || next.y !== this.bounds.y ||
      next.width !== this.bounds.width || next.height !== this.bounds.height
    );
    this.bounds = next;
    this.visible = visible;
    if (changed) this.boundsGeneration += 1;
    if (this.visible && valid) this.ensureSurface().setBounds(this.bounds);
    this.surface?.setVisible(this.visible);
    this.emitState();
  }

  private isReady(): boolean {
    return this.ready && this.visible && this.boundsGeneration > 0 &&
      this.bounds.width > 0 && this.bounds.height > 0;
  }

  private notReadyResult(id: string): BrowserCommandResult {
    return {
      id,
      ok: false,
      error: "Browser is not ready (loading or no valid bounds)",
      code: "BROWSER_NOT_READY",
      ready: this.ready,
      boundsGeneration: this.boundsGeneration,
    };
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.surface?.setVisible(visible);
    this.emitState();
  }

  stop(): void {
    this.surface?.webContents.stop();
    this.emitState();
  }

  async navigate(url: string): Promise<void> {
    if (!this.isAllowedUrl(url)) throw new Error("Only http(s) pages can be previewed");
    // Visibility is owned by the renderer placeholder: an agent-driven open
    // must not paint the view over whatever tab the user is currently on.
    this.ready = false;
    const surface = this.ensureSurface();
    await surface.webContents.loadURL(url);
    this.emitState();
  }

  async executeCommand(command: BrowserCommand): Promise<BrowserCommandResult> {
    try {
      const contents = this.ensureSurface().webContents;
      switch (command.kind) {
        case "open": {
          if (!command.url) return { id: command.id, ok: false, error: "missing url" };
          await this.navigate(command.url);
          return {
            id: command.id,
            ok: true,
            url: contents.getURL() || command.url,
            title: contents.getTitle(),
          };
        }
        case "read": {
          if (!this.isReady()) return this.notReadyResult(command.id);
          const raw = (await contents.executeJavaScript(SNAPSHOT_SCRIPT)) as {
            text?: string;
            url?: string;
            title?: string;
          };
          return {
            id: command.id,
            ok: true,
            text: raw.text ?? "",
            url: raw.url ?? contents.getURL(),
            title: raw.title ?? contents.getTitle(),
          };
        }
        case "screenshot": {
          if (!this.isReady()) return this.notReadyResult(command.id);
          if (contents.isDestroyed?.()) return { id: command.id, ok: false, error: "browser destroyed" };
          const image = await contents.capturePage();
          if (image.isEmpty?.()) return { id: command.id, ok: false, error: "empty screenshot" };
          return {
            id: command.id,
            ok: true,
            image: { data: Buffer.from(image.toPNG()).toString("base64"), mimeType: "image/png" },
            url: contents.getURL(),
            title: contents.getTitle(),
            ready: true,
            boundsGeneration: this.boundsGeneration,
          };
        }
        case "back":
          contents.goBack();
          return { id: command.id, ok: true, url: contents.getURL(), title: contents.getTitle() };
        case "forward":
          contents.goForward();
          return { id: command.id, ok: true, url: contents.getURL(), title: contents.getTitle() };
        case "reload":
          contents.reload();
          return { id: command.id, ok: true, url: contents.getURL(), title: contents.getTitle() };
        default:
          return { id: command.id, ok: false, error: "unsupported command" };
      }
    } catch (error) {
      return {
        id: command.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async snapshot(): Promise<BrowserPageSnapshot | null> {
    const contents = this.surface?.webContents;
    if (!contents) return null;
    if (!this.ready) {
      return {
        url: contents.getURL(),
        title: contents.getTitle(),
        text: "",
        truncated: false,
        native: true,
        webContentsId: null,
        viewport: null,
        scrollY: 0,
        ready: false,
        boundsGeneration: this.boundsGeneration,
        updatedAt: Date.now(),
      };
    }
    try {
      const raw = (await contents.executeJavaScript(SNAPSHOT_SCRIPT)) as {
        text?: string;
        url?: string;
        title?: string;
        scrollY?: number;
        width?: number;
 
        height?: number;
      };
      return {
        url: raw.url ?? contents.getURL(),
        title: raw.title ?? contents.getTitle(),
        text: (raw.text ?? "").slice(0, 120_000),
        truncated: (raw.text ?? "").length > 120_000,
        native: true,
        webContentsId: null,
        viewport: { width: raw.width ?? 0, height: raw.height ?? 0 },
        scrollY: raw.scrollY ?? 0,
        ready: this.ready,
        boundsGeneration: this.boundsGeneration,
        updatedAt: Date.now(),
      };
    } catch {
      return {
        url: contents.getURL(),
        title: contents.getTitle(),
        text: "",
        truncated: false,
        native: true,
        webContentsId: null,
        viewport: null,
        scrollY: 0,
        ready: this.ready,
        boundsGeneration: this.boundsGeneration,
        updatedAt: Date.now(),
      };
    }
  }

  destroy(): void {
    this.surface?.close?.();
    this.surface = null;
    this.listeners.clear();
  }

  private emitState(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch {
        // A renderer that has gone away must not break the Main view.
      }
    }
  }
}
