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
import { getElectronApi, type BrowserState } from "@/lib/electron-api";

/**
 * Built-in browser (right panel).
 *
 * The page itself is a Main-owned WebContentsView. This component draws only
 * the address bar and a DOM placeholder, then reports the placeholder rect over
 * the preload bridge. It never creates a webview, iframe or browser instance.
 */

interface ManagedProcessSummary {
  id: string;
  status: string;
  ready: boolean;
  url: string | null;
  name: string;
}

export function normalizeAddress(input: string): string {
  const value = input.trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(\/|$)/i.test(value)) return `http://${value}`;
  if (/^[\w.-]+:\d+(\/|$)/.test(value)) return `http://${value}`;
  return `https://${value}`;
}

const iconButton =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-[#ECECEF] hover:text-ink disabled:opacity-35";

export function BrowserPanel({
  active = true,
}: {
  active?: boolean;
  /** Kept for FilePanel compatibility; Main captures screenshots directly. */
  onBeforeCapture?: () => Promise<(() => void) | undefined>;
}) {
  const api = useMemo(() => getElectronApi(), []);
  const supported = Boolean(api?.browserNavigate && api.browserSetBounds);
  const hostRef = useRef<HTMLDivElement | null>(null);

  const [address, setAddress] = useState("");
  const [pageUrl, setPageUrl] = useState("");
  const [pageTitle, setPageTitle] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [navState, setNavState] = useState({ back: false, forward: false });
  const [follow, setFollow] = useState(true);
  const [processes, setProcesses] = useState<ManagedProcessSummary[]>([]);
  const followedUrlRef = useRef("");

  const previewUrl = useMemo(() => {
    const ready = processes.find((item) => item.status === "running" && item.ready && item.url);
    return ready?.url ?? null;
  }, [processes]);

  const applyState = useCallback((state: BrowserState | null) => {
    if (!state) return;
    setPageUrl(state.url);
    setPageTitle(state.title);
    setLoading(state.loading);
    setNavState({ back: state.canGoBack, forward: state.canGoForward });
    if (state.url) setAddress(state.url);
  }, []);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void api.browserGetState?.().then((state) => {
      if (!cancelled) applyState(state);
    });
    const offState = api.onBrowserState?.(applyState);
    const offOpen = api.onBrowserAgentOpen?.(() => {
      window.dispatchEvent(new Event("piforge:browser-open"));
    });
    return () => {
      cancelled = true;
      offState?.();
      offOpen?.();
    };
  }, [api, applyState]);

  // Report the placeholder rect to Main. Only the active tab owns visibility.
  useEffect(() => {
    if (!supported || !api?.browserSetBounds) return;
    const host = hostRef.current;
    if (!host) return;
    const apply = () => {
      const rect = host.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      void api.browserSetBounds!(
        { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        active,
      );
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(host);
    window.addEventListener("resize", apply);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", apply);
      void api.browserSetBounds!({ x: 0, y: 0, width: 0, height: 0 }, false);
    };
  }, [active, api, supported]);

  const navigate = useCallback(async (raw: string) => {
    const url = normalizeAddress(raw);
    if (!url) return;
    setError(null);
    setAddress(url);
    if (!api?.browserNavigate) {
      setError("内置浏览器仅在桌面端可用。");
      return;
    }
    setLoading(true);
    try {
      const result = await api.browserNavigate(url);
      if (!result.ok) {
        setError(result.error ?? "加载失败");
        return;
      }
      applyState(result.state ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [api, applyState]);

  const runAction = useCallback(async (action: "back" | "forward" | "reload" | "stop") => {
    if (!api?.browserAction) return;
    setError(null);
    const result = await api.browserAction(action);
    if (!result.ok) setError(result.error ?? "浏览器操作失败");
    applyState(result.state ?? null);
  }, [api, applyState]);

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

  useEffect(() => {
    if (!follow || !previewUrl || followedUrlRef.current === previewUrl) return;
    followedUrlRef.current = previewUrl;
    void navigate(previewUrl);
  }, [follow, previewUrl, navigate]);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    void navigate(address);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <form
        onSubmit={handleSubmit}
        className="flex h-9 shrink-0 items-center gap-1 border-b border-gray-200/60 bg-[#F5F5F7] px-1.5"
      >
        <button type="button" onClick={() => void runAction("back")} disabled={!navState.back} title="后退" aria-label="后退" className={iconButton}>
          <ArrowLeft size={13} strokeWidth={2} />
        </button>
        <button type="button" onClick={() => void runAction("forward")} disabled={!navState.forward} title="前进" aria-label="前进" className={iconButton}>
          <ArrowRight size={13} strokeWidth={2} />
        </button>
        <button type="button" onClick={() => void runAction(loading ? "stop" : "reload")} disabled={!pageUrl} title={loading ? "停止" : "刷新"} aria-label={loading ? "停止" : "刷新"} className={iconButton}>
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
            disabled={!supported}
            className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-ink outline-none placeholder:text-ink-faint disabled:opacity-50"
          />
        </div>

        <button type="button" onClick={openExternal(pageUrl)} disabled={!pageUrl} title="在系统浏览器打开" aria-label="在系统浏览器打开" className={iconButton}>
          <SquareArrowOutUpRight size={12} strokeWidth={1.9} />
        </button>
      </form>

      {(previewUrl || pageTitle) && (
        <div className="flex h-6 shrink-0 items-center gap-1.5 border-b border-gray-200/50 bg-white px-2 text-[10.5px] text-ink-faint">
          {previewUrl && (
            <button
              type="button"
              onClick={() => void navigate(previewUrl)}
              title={`预览 ${previewUrl}`}
              className={`flex min-w-0 items-center gap-1 rounded px-1 py-0.5 transition-colors hover:bg-[#ECECEF] ${follow ? "text-accent-strong" : "text-ink-muted"}`}
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
            className={`ml-auto shrink-0 rounded px-1.5 py-0.5 transition-colors hover:bg-[#ECECEF] ${follow ? "text-accent-strong" : "text-ink-faint"}`}
          >
            自动预览 {follow ? "开" : "关"}
          </button>
        </div>
      )}

      {error && <p className="shrink-0 border-b border-red-100 bg-red-50 px-2 py-1 text-[10.5px] text-red-600">{error}</p>}

      <div ref={hostRef} className="relative min-h-0 flex-1 overflow-hidden bg-white">
        {!supported && (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
            <Globe size={22} strokeWidth={1.4} className="text-ink-faint" aria-hidden="true" />
            <p className="text-[12px] text-ink-muted">内置浏览器仅在桌面端可用</p>
            <p className="text-[11px] leading-5 text-ink-faint">
              浏览器由 Electron Main 持有；Next/Renderer 只负责这块占位区域。
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function openExternal(url: string) {
  return () => {
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  };
}

export default BrowserPanel;
