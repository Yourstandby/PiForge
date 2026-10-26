"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  Globe,
  Loader2,
  RefreshCw,
  Settings2,
  Terminal,
  XCircle,
} from "lucide-react";
import type { DevEnvironmentReport } from "@contract/domains/dev-environment";
import { ModalSurface } from "./ModalSurface";
import { ErrorNotice } from "./ErrorNotice";

type Tab = "environment" | "browser";

function Badge({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${
        ok
          ? "border-[#CBE6D5] bg-[#F2FBF5] text-[#2F7A55]"
          : "border-[#F0D5D2] bg-[#FDF6F5] text-[#B0443C]"
      }`}
    >
      {ok ? <CheckCircle2 size={10} strokeWidth={2.4} /> : <XCircle size={10} strokeWidth={2.4} />}
      {children}
    </span>
  );
}

function Switch({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex w-full flex-col gap-1 rounded-lg border border-border bg-white px-3 py-2.5 text-left transition-colors hover:bg-[#FBFBFD] disabled:opacity-50"
    >
      <span className="flex w-full items-center justify-between gap-3">
        <span className="min-w-0 truncate text-[12.5px] font-medium text-ink">{label}</span>
        {/* 轨道：显式 left 定位，不依赖绝对定位元素的静态位置（button 的 text-align:center
            会把 left:auto 的滑块推到中线，导致滑块居中而不是贴边）。 */}
        <span
          aria-hidden="true"
          className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors duration-150 ${
            checked ? "border-accent bg-accent" : "border-[#D9DDE5] bg-[#ECEEF2]"
          }`}
        >
          <span
            className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-all duration-150 ${
              checked ? "left-[24px]" : "left-0.5"
            }`}
          />
        </span>
      </span>
      <span className="text-[11px] leading-4 text-ink-faint">{hint}</span>
    </button>
  );
}

/**
 * Settings → 开发环境:
 *  - 环境检测: Host-side PATH scan (Node / Python / Git / Bash / Bun / jq …).
 *  - 浏览器权限: global read / interact grants for the web_preview tool.
 *    Unchecked capabilities trigger a per-session confirmation dialog instead.
 */
export function DevEnvironmentConfig({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("environment");

  const [report, setReport] = useState<DevEnvironmentReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [browserRead, setBrowserRead] = useState(false);
  const [browserInteract, setBrowserInteract] = useState(false);
  const [permissionsLoaded, setPermissionsLoaded] = useState(false);
  const [permissionsSaved, setPermissionsSaved] = useState(false);
  /** 串行化保存：连点时只保留最后一次的值，避免「保存中按钮被禁用 → 点击被吞」。 */
  const pendingPermissionsRef = useRef<{ read: boolean; interact: boolean } | null>(null);
  const savingPermissionsRef = useRef(false);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  const loadEnvironment = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/environment${refresh ? "?refresh=1" : ""}`);
      const data = (await res.json()) as DevEnvironmentReport & { error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setReport(data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadEnvironment();
  }, [loadEnvironment]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/desktop-settings")
      .then((res) => res.json())
      .then((data: { browserReadEnabled?: boolean; browserInteractEnabled?: boolean }) => {
        if (cancelled) return;
        setBrowserRead(data.browserReadEnabled === true);
        setBrowserInteract(data.browserInteractEnabled === true);
      })
      .catch(() => {
        /* defaults stay off */
      })
      .finally(() => {
        if (!cancelled) setPermissionsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const savePermissions = useCallback(async (read: boolean, interact: boolean) => {
    pendingPermissionsRef.current = { read, interact };
    if (savingPermissionsRef.current) return;
    savingPermissionsRef.current = true;
    try {
      while (pendingPermissionsRef.current) {
        const next = pendingPermissionsRef.current;
        pendingPermissionsRef.current = null;
        setError(null);
        const res = await fetch("/api/desktop-settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            browserReadEnabled: next.read,
            browserInteractEnabled: next.interact,
          }),
        });
        const data = (await res.json()) as { error?: string };
        if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setPermissionsSaved(true);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => {
        setPermissionsSaved(false);
        savedTimerRef.current = null;
      }, 1800);
    } catch (e: unknown) {
      pendingPermissionsRef.current = null;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      savingPermissionsRef.current = false;
    }
  }, []);

  const changeBrowserRead = (next: boolean) => {
    setBrowserRead(next);
    void savePermissions(next, browserInteract);
  };

  const changeBrowserInteract = (next: boolean) => {
    setBrowserInteract(next);
    void savePermissions(browserRead, next);
  };

  const missingRequired = report?.missingRequired ?? [];

  return (
    <ModalSurface
      panelClassName="t-modal is-open ui-dialog-surface flex w-full max-w-2xl flex-col overflow-hidden rounded-[14px]"
      ariaLabelledBy="dev-env-title"
    >
      <div className="flex items-center justify-between border-b border-divider px-4 py-3">
        <h3 id="dev-env-title" className="flex items-center gap-1.5 text-[14px] font-semibold text-ink">
          <Terminal size={14} strokeWidth={1.8} className="text-accent" aria-hidden="true" />
          开发环境
        </h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭"
          className="rounded px-2 py-1 text-[16px] leading-none text-ink-muted hover:bg-[#ECECEF] hover:text-ink"
        >
          ✕
        </button>
      </div>

      <div className="flex shrink-0 items-center gap-1 border-b border-divider px-3 py-2">
        {([
          { id: "environment" as const, label: "环境检测", icon: <Terminal size={12} strokeWidth={1.9} /> },
          { id: "browser" as const, label: "浏览器权限", icon: <Globe size={12} strokeWidth={1.9} /> },
        ]).map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            aria-selected={tab === item.id}
            role="tab"
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] transition-colors ${
              tab === item.id
                ? "bg-[#E8EFFB] font-medium text-accent"
                : "text-ink-muted hover:bg-[#F2F3F6] hover:text-ink"
            }`}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {tab === "environment" ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-start justify-between gap-3">
              <p className="text-[12px] leading-5 text-ink-muted">
                由 Agent Host 直接扫描 PATH，检查 Node、Python、Git、Bash、Bun、jq 等工具是否可用，
                并显示版本号与可执行文件路径。
              </p>
              <button
                type="button"
                onClick={() => void loadEnvironment(true)}
                disabled={loading || refreshing}
                className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[11.5px] text-ink-muted transition-colors hover:bg-[#ECECEF] hover:text-ink disabled:opacity-50"
              >
                <RefreshCw size={11} strokeWidth={2} className={refreshing ? "animate-spin" : undefined} />
                重新检测
              </button>
            </div>

            {report && (
              <p className="font-mono text-[10.5px] text-ink-faint">
                {report.platform} · {report.arch} · Agent Host {report.hostNode}
              </p>
            )}

            {missingRequired.length > 0 && (
              <div className="rounded-lg border border-[#F0D5D2] bg-[#FDF6F5] px-3 py-2 text-[12px] text-[#B0443C]">
                缺少关键工具：{missingRequired.join("、")}。部分 Agent 工作流（如运行脚本、Git 操作）可能无法执行。
              </div>
            )}

            {loading ? (
              <p className="flex items-center gap-1.5 py-6 text-[12px] text-ink-faint">
                <Loader2 size={12} className="animate-spin" aria-hidden="true" /> 正在检测开发工具…
              </p>
            ) : error ? (
              <ErrorNotice
                message={error}
                className="block py-4 text-[12px] text-danger"
                fallback={<span className="block py-4 text-[12px] text-ink-faint">正在等待本地引擎就绪…</span>}
              />
            ) : (
              <div className="overflow-hidden rounded-lg border border-border">
                {(report?.tools ?? []).map((tool, index) => (
                  <div
                    key={tool.id}
                    className={`flex items-start gap-3 px-3 py-2 ${index > 0 ? "border-t border-divider" : ""}`}
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[12.5px] font-medium text-ink">{tool.name}</span>
                        <span className="font-mono text-[10px] text-ink-faint">{tool.command}</span>
                        {tool.required && (
                          <span className="rounded border border-[#D9E5FB] bg-[#F5F9FF] px-1 py-0.5 text-[9.5px] text-accent-strong">
                            关键
                          </span>
                        )}
                        <Badge ok={tool.found}>{tool.found ? "可用" : "未找到"}</Badge>
                      </div>
                      {tool.found ? (
                        <>
                          {tool.version && (
                            <span className="truncate font-mono text-[11px] text-ink-muted">{tool.version}</span>
                          )}
                          {tool.path && (
                            <span className="truncate font-mono text-[10.5px] text-ink-faint" title={tool.path}>
                              {tool.path}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-[11px] text-ink-faint">
                          {tool.error ?? "未在 PATH 中找到"}；安装后点「重新检测」。
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-[12px] leading-5 text-ink-muted">
              内置浏览器是敏感面：读取页面可能暴露登录态内容，导航会以你的身份访问站点。
              未开启的能力在 Agent 调用时会弹出确认框，确认后仅对当前会话生效。
            </p>
            <Switch
              label="只读：读取网页文本 / 截图"
              hint="允许 Agent 通过 web_preview 读取当前页面文本，或截取可视区域截图。"
              checked={browserRead}
              disabled={!permissionsLoaded}
              onChange={changeBrowserRead}
            />
            <Switch
              label="允许交互：打开 / 导航浏览器"
              hint="允许 Agent 在内置浏览器中打开 URL（例如本地 dev server）。输入与点击等写操作仍由用户执行。"
              checked={browserInteract}
              disabled={!permissionsLoaded}
              onChange={changeBrowserInteract}
            />
            <div className="flex items-center gap-2 rounded-lg bg-[#F7F8FA] px-3 py-2 text-[11px] text-ink-faint">
              <Settings2 size={12} strokeWidth={1.9} className="shrink-0" />
              权限写入 desktop-settings.json，由 Agent Host 在每次 web_preview 调用前校验。
            </div>
            {permissionsSaved && (
              <p role="status" className="text-[12px] text-[#3E8A63]">
                已保存，立即生效。
              </p>
            )}
            {error && (
              <ErrorNotice className="block text-[12px] text-danger" message={error} />
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-end border-t border-divider px-4 py-3">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-border px-3 py-1.5 text-[12px] text-ink-muted transition-colors hover:bg-[#ECECEF] hover:text-ink"
        >
          关闭
        </button>
      </div>
    </ModalSurface>
  );
}

export default DevEnvironmentConfig;
