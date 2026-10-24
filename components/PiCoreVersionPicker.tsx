"use client";

/**
 * pi 核心版本选择器：可自由升级 / 降级（以 pi 为核心的桌面端，核心版本不该被钉死）。
 *
 * - 版本列表来自 `/api/upstream/versions`（registry 全量版本，自带 30 分钟缓存）；
 * - 真正装包由 Electron Main 执行（Next 侧禁止 spawn），浏览器开发模式只给命令提示；
 * - 核心是构建期依赖，装完必须重启应用才生效 —— UI 不假装"热替换成功"。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowDownCircle, ArrowUpCircle, RotateCcw } from "lucide-react";
import { compareVersions, isPrerelease } from "@/lib/version-compare";
import type { PiCoreVersionList } from "@/lib/upstream-version";
import { getElectronApi, type PiCoreApi, type PiCoreInstallResult } from "@/lib/electron-api";

interface PiCoreVersionPickerProps {
  local: string | null;
  latest: string | null;
  checking?: boolean;
  onRecheck?: () => void;
}

const inputClass =
  "rounded-lg border border-divider bg-white px-2 py-1 text-[12px] text-ink outline-none transition-colors focus:border-[#C9D9F2]";

export function PiCoreVersionPicker({ local, latest, checking, onRecheck }: PiCoreVersionPickerProps) {
  const [api, setApi] = useState<PiCoreApi | null>(null);
  const [list, setList] = useState<PiCoreVersionList | null>(null);
  const [target, setTarget] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [result, setResult] = useState<PiCoreInstallResult | null>(null);
  const [showPrerelease, setShowPrerelease] = useState(false);

  useEffect(() => {
    setApi(getElectronApi()?.piCore ?? null);
  }, []);

  useEffect(() => {
    let alive = true;
    fetch("/api/upstream/versions")
      .then((response) => (response.ok ? response.json() : null))
      .then((data: PiCoreVersionList | null) => {
        if (alive && data) setList(data);
      })
      .catch(() => {
        // 离线：只保留本地版本展示
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!api) return undefined;
    return api.onProgress((chunk) => {
      const line = chunk.split(/\r?\n/).filter(Boolean).pop();
      if (line) setProgress(line.trim().slice(0, 120));
    });
  }, [api]);

  const current = local ?? list?.local ?? null;
  const versions = useMemo(() => {
    const all = list?.versions ?? [];
    return showPrerelease ? all : all.filter((version) => !isPrerelease(version));
  }, [list, showPrerelease]);

  const effective = target || versions[0] || current || "";
  const direction = current && effective ? compareVersions(effective, current) : 0;
  const recheck = useCallback(async () => {
    onRecheck?.();
    try {
      const response = await fetch("/api/upstream/versions?force=1");
      if (response.ok) setList((await response.json()) as PiCoreVersionList);
    } catch {
      // 保持旧列表
    }
  }, [onRecheck]);

  const install = useCallback(async () => {
    if (!api || !effective) return;
    setBusy(true);
    setResult(null);
    setProgress("正在调用 npm…");
    try {
      const outcome = await api.install(effective);
      setResult(outcome);
      setProgress(null);
      if (outcome.ok) setList((prev) => (prev ? { ...prev, local: outcome.installed ?? prev.local } : prev));
    } catch (error) {
      setResult({
        ok: false,
        version: effective,
        installed: null,
        restartRequired: true,
        error: error instanceof Error ? error.message : String(error),
      });
      setProgress(null);
    } finally {
      setBusy(false);
    }
  }, [api, effective]);

  const actionLabel = busy
    ? "安装中…"
    : !current || !effective || direction === 0
      ? "已是该版本"
      : direction > 0
        ? `升级到 ${effective}`
        : `降级到 ${effective}`;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="选择 pi 核心版本"
          className={inputClass}
          value={effective}
          disabled={busy || versions.length === 0}
          onChange={(event) => {
            setTarget(event.target.value);
            setResult(null);
          }}
        >
          {versions.length === 0 && <option value="">{current ?? "读取中…"}</option>}
          {versions.map((version) => (
            <option key={version} value={version}>
              {version}
              {version === current ? "（当前）" : ""}
              {version === latest ? "（最新）" : ""}
              {isPrerelease(version) ? " · 预发布" : ""}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={() => void install()}
          disabled={!api || busy || direction === 0}
          title={api ? actionLabel : "浏览器开发模式无法装包，请用底部命令"}
          className={`flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[12px] transition-colors disabled:opacity-50 ${
            direction > 0
              ? "border-[#C9D9F2] bg-[#E8EFFB] text-[#2563EB] hover:bg-[#DCE7F9]"
              : direction < 0
                ? "border-[#F0C9A8] bg-[#FDF3E8] text-[#C2661A] hover:bg-[#FBE9D8]"
                : "border-divider text-ink-muted hover:bg-[#F5F5F7]"
          }`}
        >
          {direction > 0 ? (
            <ArrowUpCircle size={12} strokeWidth={2} aria-hidden="true" />
          ) : direction < 0 ? (
            <ArrowDownCircle size={12} strokeWidth={2} aria-hidden="true" />
          ) : (
            <RotateCcw size={12} strokeWidth={2} aria-hidden="true" />
          )}
          {actionLabel}
        </button>

        <button
          type="button"
          onClick={() => void recheck()}
          disabled={checking || busy}
          className="rounded-lg border border-divider px-2.5 py-1 text-[12px] text-ink-muted transition-colors hover:bg-[#F5F5F7] hover:text-ink disabled:opacity-50"
        >
          {checking ? "检查中…" : "刷新版本列表"}
        </button>

        <label className="flex items-center gap-1 text-[11px] text-ink-faint">
          <input
            type="checkbox"
            checked={showPrerelease}
            disabled={busy}
            onChange={(event) => setShowPrerelease(event.target.checked)}
          />
          显示预发布
        </label>
      </div>

      {busy && <p className="text-[11px] text-ink-muted">正在安装：{progress ?? "准备中…"}（勿关闭应用）</p>}

      {result?.ok && (
        <p className="flex items-center gap-1.5 text-[11px] text-[#2563EB]">
          已装上 {result.installed ?? result.version}，重启后生效。
          <button
            type="button"
            onClick={() => void api?.relaunch()}
            className="rounded-md border border-[#C9D9F2] bg-white px-2 py-0.5 text-[11px] text-[#2563EB] hover:bg-[#E8EFFB]"
          >
            立即重启
          </button>
        </p>
      )}

      {result && !result.ok && (
        <p className="flex items-start gap-1 text-[11px] leading-4 text-[#B42318]">
          <AlertTriangle size={12} strokeWidth={2} aria-hidden="true" className="mt-0.5 shrink-0" />
          <span>
            {result.error}
            {result.log ? `｜npm: ${result.log.split(/\r?\n/).filter(Boolean).slice(-1)[0]?.slice(0, 160)}` : ""}
          </span>
        </p>
      )}

      {/* 没 npm / 目录只读 / 网络不通时，一键切换装不上 → 直接给完整安装包出口 */}
      {(result?.releaseUrl && !result.ok) ? (
        <p className="text-[11px] leading-4 text-ink-faint">
          换条路：
          <a
            href={result.releaseUrl}
            target="_blank"
            rel="noreferrer"
            className="text-[#2563EB] underline decoration-dotted underline-offset-2 hover:text-[#1D4ED8]"
          >
            下载完整安装包（GitHub Releases）
          </a>
          ，覆盖安装后仍保留会话。
        </p>
      ) : null}

      {direction < 0 && !busy && (
        <p className="text-[11px] leading-4 text-ink-faint">
          降级可回滚到旧核心，但旧版本可能不认新会话格式，建议先为新会话建分支。
        </p>
      )}

      {!api && (
        <p className="text-[11px] leading-4 text-ink-faint">
          浏览器开发模式不支持一键切换，请执行：
          <code className="ml-1 rounded bg-[#F0F1F4] px-1 py-0.5 text-[11px]">
            npm install @earendil-works/pi-coding-agent@{effective || "版本号"} --save-exact
          </code>
        </p>
      )}
    </div>
  );
}
