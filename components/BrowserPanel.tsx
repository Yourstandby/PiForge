"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CircleDot,
  Globe,
  Loader2,
  RefreshCw,
  SquareArrowOutUpRight,
} from "lucide-react";
import type { BrowserCommand, BrowserCommandResult, BrowserPageSnapshot } from "@/lib/browser-bridge";
import { getElectronApi } from "@/lib/electron-api";

/**
 * Built-in browser for the right panel.
 *
 * Electron mode renders a real `<webview>` guest (isolated session partition,
 * no preload, no node) so any dev server can be previewed. Browser mode falls
 * back to a sandboxed `<iframe>` — many sites refuse framing, so that path is
 * preview-only.
 *
 * The panel is also the eyes of the `web_preview` agent tool: it polls
 * /api/browser/bridge for commands, executes them against the guest page and
 * posts snapshots + results back.
 */

type WebviewElement = HTMLElement & {
  loadURL: (url: string) => Promise<void>;
  reload: () => void;
  stop: () => void;
  goBack: () => void;
  goForward: () => void;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  getURL: () => string;
  getTitle: () => string;
  getWebContentsId: () => number;
  executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>;
  capturePage?: () => Promise<{ toPNG: () => Uint8Array }>;
  addEventListener: (type: string, listener: (event: Event) => void) => void;
  removeEventListener: (type: string, listener: (event: Event) => void) => void;
};

type GuestEvent = Event & { url?: string; errorCode?: number; errorDescription?: string; isMainFrame?: boolean };

interface ManagedProcessSummary {
  id: string;
  status: string;
  ready: boolean;
  url: string | null;
  name: string;
}

/** Page-side snippet: text + geometry, small enough to cross IPC. */
const SNAPSHOT_SCRIPT = `(() => {
  const body = document.body ? document.body.innerText || "" : "";
  return {
    text: body.slice(0, 200000),
    url: location.href,
    title: document.title,
    scrollY: window.scrollY || 0,
    width: window.innerWidth || 0,
    height: window.innerHeight || 0,
  };
})()`;

/** Loopback / port-looking input gets http://, everything else https://. */
export function normalizeAddress(input: string): string {
  const value = input.trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(\/|$)/i.test(value)) return `http://${value}`;
  if (/^[\w.-]+:\d+(\/|$)/.test(value)) return `http://${value}`;
  return `https://${value}`;
}

function readError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function BrowserPanel({
  active = true,
  onBeforeCapture,
}: {
  /** True when the Browser tab is the visible one. */
  active?: boolean;
  /** Called before a screenshot so a hidden panel can reveal itself. */
  onBeforeCapture?: () => Promise<(() => void) | undefined>;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const webviewRef = useRef<WebviewElement | null>(null);

  const [native, setNative] = useState(false);
  const [address, setAddress] = useState("");
  const [pageUrl, setPageUrl] = useState("");
  const [pageTitle, setPageTitle] = useState("");
  const [frameSrc, setFrameSrc] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [navState, setNavState] = useState({ back: false, forward: false });
  const [follow, setFollow] = useState(true);
  const [processes, setProcesses] = useState<ManagedProcessSummary[]>([]);
  const followedUrlRef = useRef<string>("");

  const previewUrl = useMemo(() => {
    const ready = processes.find((item) => item.status === "running" && item.ready && item.url);
    return ready?.url ?? null;
  }, [processes]);

  // ---------------------------------------------------------------- navigate
  const navigate = useCallback(async (raw: string) => {
    const url = normalizeAddress(raw);
    if (!url) return;
    setError(null);
    setAddress(url);
    setPageUrl(url);
    setLoading(true);

    const view = webviewRef.current;
    if (!view) {
      // Browser fallback: iframe navigation only.
      setFrameSrc(url);
      setLoading(false);
      return;
    }

    try {
      await withTimeout(view.loadURL(url), 20_000, `加载超时：${url}`);
    } catch (e) {
      setLoading(false);
      setError(readError(e));
    }
  }, []);

  // ------------------------------------------------------------ webview init
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const probe = document.createElement("webview") as Partial<WebviewElement>;
    const supported = typeof probe.getWebContentsId === "function";
    setNative(supported);
    if (!supported) return;

    const view = document.createElement("webview") as WebviewElement;
    // Dedicated persistent partition: the guest must NOT share the app session,
    // otherwise the CSP the main process injects into app responses would also
    // be applied to every previewed site.
    view.setAttribute("partition", "persist:piforge-browser");
    view.style.cssText = "display:flex;width:100%;height:100%;border:0;background:#fff;";
    webviewRef.current = view;
    host.appendChild(view);

    const syncNav = () => setNavState({ back: view.canGoBack(), forward: view.canGoForward() });

    const onStart = () => setLoading(true);
    const onStop = () => {
      setLoading(false);
      const url = view.getURL();
      if (url) {
        setPageUrl(url);
        setAddress(url);
      }
      setPageTitle(view.getTitle() || "");
      syncNav();
    };
    const onNavigate = (event: Event) => {
      const url = (event as GuestEvent).url;
      if (typeof url === "string" && url) {
        setPageUrl(url);
        setAddress(url);
      }
      syncNav();
    };
    const onTitle = () => setPageTitle(view.getTitle() || "");
    const onFail = (event: Event) => {
      const { errorCode, errorDescription, isMainFrame } = event as GuestEvent;
      // -3 = ERR_ABORTED: a superseded navigation, not a real failure.
      if (errorCode === -3 || isMainFrame === false) return;
      setLoading(false);
      setError(errorDescription ? `${errorDescription} (${errorCode})` : `加载失败 (${errorCode})`);
    };

    view.addEventListener("did-start-loading", onStart);
    view.addEventListener("did-stop-loading", onStop);
    view.addEventListener("did-navigate", onNavigate);
    view.addEventListener("did-navigate-in-page", onNavigate);
    view.addEventListener("page-title-updated", onTitle);
    view.addEventListener("did-fail-load", onFail);

    return () => {
      view.removeEventListener("did-start-loading", onStart);
      view.removeEventListener("did-stop-loading", onStop);
      view.removeEventListener("did-navigate", onNavigate);
      view.removeEventListener("did-navigate-in-page", onNavigate);
      view.removeEventListener("page-title-updated", onTitle);
      view.removeEventListener("did-fail-load", onFail);
      webviewRef.current = null;
      view.remove();
    };
  }, []);

  // ------------------------------------------------------- bridge: snapshot
  const captureSnapshot = useCallback(async (): Promise<Partial<BrowserPageSnapshot> | null> => {
    const view = webviewRef.current;
    if (!view) {
      if (!frameSrc) return null;
      return { url: frameSrc, title: "", text: "", native: false, webContentsId: null };
    }
    try {
      const raw = (await view.executeJavaScript(SNAPSHOT_SCRIPT, true)) as {
        text?: string;
        url?: string;
        title?: string;
        scrollY?: number;
        width?: number;
        height?: number;
      };
      return {
        url: raw.url ?? view.getURL(),
        title: raw.title ?? view.getTitle(),
        text: raw.text ?? "",
        native: true,
        webContentsId: view.getWebContentsId(),
        scrollY: raw.scrollY ?? 0,
        viewport: { width: raw.width ?? 0, height: raw.height ?? 0 },
      };
    } catch {
      // Cross-origin / mid-navigation: report the URL only, without page text.
      return { url: pageUrl, title: pageTitle, text: "", native: true, webContentsId: view.getWebContentsId() };
    }
  }, [frameSrc, pageUrl, pageTitle]);

  const postBridge = useCallback(async (payload: { snapshot?: Partial<BrowserPageSnapshot>; result?: BrowserCommandResult }) => {
    try {
      await fetch("/api/browser/bridge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
      });
    } catch {
      // The bridge is best-effort; a miss just means the tool falls back.
    }
  }, []);

  // -------------------------------------------------------- bridge: commands
  const runCommand = useCallback(
    async (command: BrowserCommand): Promise<BrowserCommandResult> => {
      const view = webviewRef.current;
      try {
        if (command.kind === "open") {
          if (!command.url) return { id: command.id, ok: false, error: "missing url" };
          await navigate(command.url);
          // The agent drove this navigation: surface the page instead of
          // loading it invisibly behind another tab.
          window.dispatchEvent(new CustomEvent("piforge:browser-open", { detail: { url: command.url } }));
          return {
            id: command.id,
            ok: true,
            url: view?.getURL() || command.url,
            title: view?.getTitle() || "",
          };
        }

        if (command.kind === "read") {
          if (!view) {
            return {
              id: command.id,
              ok: false,
              error: "浏览器面板运行在 iframe 模式下（非桌面端），无法读取跨域页面内容。",
            };
          }
          const raw = (await view.executeJavaScript(SNAPSHOT_SCRIPT, true)) as { text?: string; url?: string; title?: string };
          return {
            id: command.id,
            ok: true,
            text: raw.text ?? "",
            url: raw.url ?? view.getURL(),
            title: raw.title ?? view.getTitle(),
          };
        }

        // screenshot
        if (!view) {
          return { id: command.id, ok: false, error: "截图只能在桌面端（webview）下使用。" };
        }
        const api = getElectronApi();
        let shot: { data: string; mimeType: string } | null = null;
        const capture = async () => {
          const contentsId = view.getWebContentsId();
          if (api?.captureWebview && Number.isFinite(contentsId)) {
            return api.captureWebview(contentsId);
          }
          if (view.capturePage) {
            // Fallback: guest-side capture (may not survive the webview IPC bridge).
            const image = await view.capturePage();
            const png = image?.toPNG?.();
            if (png && png.length > 0) return { data: pngToBase64(png), mimeType: "image/png" };
          }
          return null;
        };

        const restore = await onBeforeCapture?.();
        try {
          shot = await capture();
          // A guest that was hidden repaints slightly late; retry once.
          if (!shot?.data) {
            await new Promise((resolve) => setTimeout(resolve, 400));
            shot = await capture();
          }
        } finally {
          restore?.();
        }
        if (!shot?.data) return { id: command.id, ok: false, error: "截图失败：主进程未返回图像。" };
        return {
          id: command.id,
          ok: true,
          image: shot,
          url: view.getURL(),
          title: view.getTitle(),
        };
      } catch (e) {
        return { id: command.id, ok: false, error: readError(e) };
      }
    },
    [navigate, onBeforeCapture],
  );

  useEffect(() => {
    let stopped = false;
    const controller = new AbortController();

    const poll = async () => {
      if (stopped) return;
      try {
        const res = await fetch("/api/browser/bridge", { cache: "no-store", signal: controller.signal });
        if (!res.ok) return;
        const data = (await res.json()) as { commands?: BrowserCommand[] };
        for (const command of data.commands ?? []) {
          if (stopped) return;
          const result = await runCommand(command);
          await postBridge({ result, snapshot: await captureSnapshot() ?? undefined });
        }
      } catch {
        // Aborted or offline — retry on the next tick.
      }
    };

    const id = window.setInterval(() => void poll(), 600);
    void poll();
    return () => {
      stopped = true;
      controller.abort();
      window.clearInterval(id);
    };
  }, [runCommand, captureSnapshot, postBridge]);

  // Push a fresh snapshot so `web_preview read` never needs a full round trip
  // when the page is already loaded (and the agent can see it after a reload).
  useEffect(() => {
    let stopped = false;
    const push = async () => {
      if (stopped || !active) return;
      const snapshot = await captureSnapshot();
      if (snapshot) await postBridge({ snapshot });
    };
    const id = window.setInterval(() => void push(), 2_500);
    const initial = window.setTimeout(() => void push(), 900);
    return () => {
      stopped = true;
      window.clearInterval(id);
      window.clearTimeout(initial);
    };
  }, [active, captureSnapshot, postBridge]);

  // ------------------------------------------------- bridge: follow dev server
  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const res = await fetch("/api/processes", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { processes?: ManagedProcessSummary[] };
        if (!stopped) setProcesses(data.processes ?? []);
      } catch {
        // ignore
      }
    };
    void load();
    const id = window.setInterval(() => void load(), 4_000);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, []);

  // Auto-preview: a dev server the agent started becomes the page, once.
  useEffect(() => {
    if (!follow || !previewUrl || followedUrlRef.current === previewUrl) return;
    followedUrlRef.current = previewUrl;
    void navigate(previewUrl);
  }, [follow, previewUrl, navigate]);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    void navigate(address);
  };

  const openExternal = () => {
    if (!pageUrl) return;
    window.open(pageUrl, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      {/* Address bar */}
      <form
        onSubmit={handleSubmit}
        className="flex h-9 shrink-0 items-center gap-1 border-b border-gray-200/60 bg-[#F5F5F7] px-1.5"
      >
        <button
          type="button"
          onClick={() => webviewRef.current?.goBack()}
          disabled={!navState.back}
          title="后退"
          aria-label="后退"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-[#ECECEF] hover:text-ink disabled:opacity-35"
        >
          <ArrowLeft size={13} strokeWidth={2} />
        </button>
        <button
          type="button"
          onClick={() => webviewRef.current?.goForward()}
          disabled={!navState.forward}
          title="前进"
          aria-label="前进"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-[#ECECEF] hover:text-ink disabled:opacity-35"
        >
          <ArrowRight size={13} strokeWidth={2} />
        </button>
        <button
          type="button"
          onClick={() => (webviewRef.current ? webviewRef.current.reload() : void navigate(pageUrl))}
          disabled={!pageUrl}
          title="刷新"
          aria-label="刷新"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-[#ECECEF] hover:text-ink disabled:opacity-35"
        >
          {loading ? <Loader2 size={13} strokeWidth={2} className="animate-spin" /> : <RefreshCw size={12.5} strokeWidth={2} />}
        </button>

        <div className="flex h-6 min-w-0 flex-1 items-center gap-1 rounded-md border border-[#E7E9EE] bg-white px-1.5 focus-within:border-accent/50">
          <Globe size={11} strokeWidth={1.9} className="shrink-0 text-ink-faint" aria-hidden="true" />
          <input
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            placeholder="localhost:3000 或 https://…"
            aria-label="地址栏"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-ink outline-none placeholder:text-ink-faint"
          />
        </div>

        <button
          type="button"
          onClick={openExternal}
          disabled={!pageUrl}
          title="在系统浏览器打开"
          aria-label="在系统浏览器打开"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-[#ECECEF] hover:text-ink disabled:opacity-35"
        >
          <SquareArrowOutUpRight size={12} strokeWidth={1.9} />
        </button>
      </form>

      {/* Dev-server chip / status */}
      {(previewUrl || pageTitle) && (
        <div className="flex h-6 shrink-0 items-center gap-1.5 border-b border-gray-200/50 bg-white px-2 text-[10.5px] text-ink-faint">
          {previewUrl && (
            <button
              type="button"
              onClick={() => void navigate(previewUrl)}
              title={`预览 ${previewUrl}`}
              className={`flex min-w-0 items-center gap-1 rounded px-1 py-0.5 transition-colors hover:bg-[#ECECEF] ${
                follow ? "text-accent-strong" : "text-ink-muted"
              }`}
            >
              <CircleDot size={9} strokeWidth={2.4} aria-hidden="true" />
              <span className="truncate font-mono">{previewUrl}</span>
            </button>
          )}
          {pageTitle && <span className="min-w-0 flex-1 truncate">{pageTitle}</span>}
          <button
            type="button"
            onClick={() => setFollow((value) => !value)}
            title="自动打开 Agent 启动的本地服务"
            aria-pressed={follow}
            className={`ml-auto shrink-0 rounded px-1.5 py-0.5 transition-colors hover:bg-[#ECECEF] ${
              follow ? "text-accent-strong" : "text-ink-faint"
            }`}
          >
            自动预览 {follow ? "开" : "关"}
          </button>
        </div>
      )}

      {error && (
        <p className="shrink-0 border-b border-red-100 bg-red-50 px-2 py-1 text-[10.5px] text-red-600">{error}</p>
      )}

      {/* Guest surface */}
      <div ref={hostRef} className="relative min-h-0 flex-1 overflow-hidden bg-white">
        {!native && !frameSrc && (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
            <Globe size={22} strokeWidth={1.4} className="text-ink-faint" aria-hidden="true" />
            <p className="text-[12px] text-ink-muted">输入 localhost:端口 预览本地页面</p>
            <p className="text-[11px] leading-5 text-ink-faint">
              桌面端使用原生 webview；浏览器模式下退化为 iframe，部分站点会拒绝嵌入。
            </p>
          </div>
        )}
        {!native && frameSrc && (
          <iframe
            key={frameSrc}
            src={frameSrc}
            title="内置浏览器预览"
            className="h-full w-full border-0 bg-white"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
            referrerPolicy="no-referrer"
          />
        )}
      </div>
    </div>
  );
}

function pngToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export default BrowserPanel;
