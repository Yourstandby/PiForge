"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowUpCircle } from "lucide-react";
import type { UpstreamVersionStatus } from "@/lib/upstream-version";

/**
 * 底栏「pi 核心版本」徽章。
 * - 正常：`pi 1.1.0`
 * - 有新版本：蓝色 `pi 1.1.0 ↑1.2.0`
 * - 点击：强制重新检测
 */
export function UpstreamVersionBadge({ compact }: { compact?: boolean }) {
  const [status, setStatus] = useState<UpstreamVersionStatus | null>(null);
  const [checking, setChecking] = useState(false);

  const load = useCallback(async (force: boolean) => {
    setChecking(true);
    try {
      const response = await fetch(`/api/upstream${force ? "?force=1" : ""}`);
      if (response.ok) setStatus((await response.json()) as UpstreamVersionStatus);
    } catch {
      // 离线环境静默降级
    } finally {
      setChecking(false);
    }
  }, []);
  useEffect(() => {
    // 不抢首屏：等浏览器空闲再查 registry（结果也有 30 分钟缓存）。
    const idle = window.requestIdleCallback;
    if (typeof idle === "function") {
      const handle = idle(() => void load(false), { timeout: 2500 });
      return () => window.cancelIdleCallback?.(handle);
    }
    const timer = window.setTimeout(() => void load(false), 1200);
    return () => window.clearTimeout(timer);
  }, [load]);

  if (!status || status.local === "unknown") return null;

  const hasUpdate = status.hasUpdate && status.latest;
  const title = hasUpdate
    ? `pi 核心 ${status.local} → ${status.latest} 可切换（打开设置选版本，升级/降级都行）`
    : `pi 核心 ${status.local}${status.latest ? "（已是最新，也可回退旧版本）" : "（无法连接 registry）"} · 点击选择版本`;

  return (
    <button
      type="button"
      onClick={() => {
        // 版本选择在设置页（需要选具体版本，徽章只能跳转），顺手刷新一次缓存
        window.dispatchEvent(new CustomEvent("piforge:open-settings", { detail: { tab: "general" } }));
        void load(true);
      }}
      title={title}
      aria-label={title}
      className={`flex shrink-0 items-center gap-1 rounded-md py-0.5 text-[10px] transition-colors duration-150 ${
        hasUpdate ? "text-[#2563EB] hover:bg-[#E8EFFB]" : "text-ink-faint hover:bg-[#ECECEF] hover:text-ink"
      } ${compact ? "px-0.5" : "px-1"}`}
    >
      {hasUpdate ? (
        <ArrowUpCircle size={10} strokeWidth={2} aria-hidden="true" className="shrink-0" />
      ) : (
        <span aria-hidden="true" className="h-[6px] w-[6px] shrink-0 rounded-full bg-[#C7CBD3]" />
      )}
      <span className="whitespace-nowrap">
        {checking ? "pi" : `pi ${status.local}`}
        {hasUpdate && ` ↑${status.latest}`}
      </span>
    </button>
  );
}
