"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "./I18nProvider";
import { useCurrency } from "@/hooks/useCurrency";
import { useDismissOnOutsideClick } from "@/hooks/useDismissOnOutsideClick";
import { UsagePopover } from "./UsagePopover";
import { subscribeLiveUsage } from "@/lib/live-usage";

import type { ContextUsage, SessionActivity, SessionStats } from "./usage-types";
import type { UpstreamProviderUsage } from "@/lib/upstream-usage/types";

export interface UsageStripProps {
  sessionStats?: SessionStats | null;
  contextUsage?: ContextUsage | null;
  activity?: SessionActivity | null;
  upstreamUsage?: UpstreamProviderUsage | null;
  allUsages?: UpstreamProviderUsage[];
  loading?: boolean;
  onRefresh?: () => void;
}

function compactTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(value);
}

/**
 * 输入框下方常驻的一行用量（费用 / 上下文 / 缓存命中 / 上游额度）。
 *
 * 之前这些数字只躲在状态栏 chip 的原生 title 里：要悬停才出现、延迟由
 * 浏览器决定、位置不可控、经常盖住正文。这里改成常驻一行 + 点击展开
 * `UsagePopover`（复用同一套面板，向上展开到对话正文区域）。
 *
 * 性能：流式期间用 ref 直接改金额文本节点，不 setState，不触发重渲染。
 */
export const UsageStrip = React.memo(function UsageStrip({
  sessionStats = null,
  contextUsage = null,
  activity = null,
  upstreamUsage = null,
  allUsages = [],
  loading = false,
  onRefresh,
}: UsageStripProps) {
  const { t } = useI18n();
  const { format4: formatMoney4 } = useCurrency();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const costRef = useRef<HTMLSpanElement>(null);

  const tks = sessionStats?.tokens;
  const cost = sessionStats?.cost ?? 0;

  /**
   * 汇率格式化函数每次渲染都是新引用：放进 ref，避免 effect 在流式期间
   * 每次渲染都退订重订（订阅抖动会让数字短暂回跳）。
   */
  const moneyRef = useRef(formatMoney4);
  moneyRef.current = formatMoney4;

  useEffect(() => {
    const setText = (el: HTMLSpanElement | null, text: string) => {
      if (!el || el.textContent === text) return;
      el.textContent = text;
    };
    const render = (value: number) =>
      setText(costRef.current, value > 0 ? moneyRef.current(value) : moneyRef.current(0));
    render(cost);
    return subscribeLiveUsage((live) => {
      render(cost + (live?.cost ?? 0));
    });
  }, [cost]);

  const toggle = useCallback(() => {
    if (containerRef.current) {
      setAnchorRect(containerRef.current.getBoundingClientRect());
    }
    setOpen((prev) => !prev);
  }, []);

  const close = useCallback(() => setOpen(false), []);
  useDismissOnOutsideClick(containerRef, open, close);

  const hasSessionData = Boolean(tks && tks.input + tks.output + tks.cacheRead + tks.cacheWrite > 0);
  const hasContext = Boolean(contextUsage?.contextWindow);
  const hasUpstream = Boolean(upstreamUsage) || allUsages.length > 0;
  if (!hasSessionData && !hasContext && !hasUpstream) return null;

  const cacheHit =
    sessionStats?.cacheHitRate != null && Number.isFinite(sessionStats.cacheHitRate)
      ? sessionStats.cacheHitRate
      : tks && tks.input + tks.cacheRead + tks.cacheWrite > 0 && tks.cacheRead > 0
        ? (tks.cacheRead / (tks.input + tks.cacheRead + tks.cacheWrite)) * 100
        : null;

  const ctxPercent = contextUsage?.percent ?? null;
  const ctxColor =
    ctxPercent !== null && ctxPercent > 90
      ? "var(--danger)"
      : ctxPercent !== null && ctxPercent > 70
        ? "var(--warning)"
        : undefined;

  let quotaText: string | null = null;
  if (upstreamUsage) {
    const window = upstreamUsage.windows?.[0];
    const balance = upstreamUsage.balance?.[0];
    if (upstreamUsage.rawLimit?.remaining != null) {
      quotaText = `${upstreamUsage.providerName} ${upstreamUsage.rawLimit.remaining}`;
    } else if (balance?.total) {
      quotaText = `${upstreamUsage.providerName} ${balance.total}${balance.currency ? ` ${balance.currency}` : ""}`;
    } else if (window) {
      quotaText = `${upstreamUsage.providerName} ${window.label} ${Math.round(window.usedPercent)}%`;
    } else {
      quotaText = upstreamUsage.providerName;
    }
  }

  return (
    <div ref={containerRef} className="relative flex min-w-0 items-center">
      <button
        type="button"
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("usage.title")}
        className={`flex h-[22px] w-full min-w-0 items-center gap-2.5 overflow-hidden rounded-md px-1.5 font-mono text-[11px] tabular-nums transition-colors duration-150 ${
          open
            ? "bg-bg-selected text-ink-soft"
            : "bg-transparent text-ink-faint hover:bg-bg-hover/60 hover:text-ink-soft"
        }`}
      >
        {hasSessionData && tks && (
          <span className="flex shrink-0 items-center gap-1">
            <span>{t("usage.strip.cost")}</span>
            <span ref={costRef} className="font-medium text-ink">
              {formatMoney4(cost)}
            </span>
          </span>
        )}

        {hasContext && (
          <span className="flex shrink-0 items-center gap-1" style={{ color: ctxColor }}>
            <span className={ctxColor ? "" : "text-ink-faint"}>{t("usage.strip.context")}</span>
            <span className={`font-medium ${ctxColor ? "" : "text-ink"}`}>
              {ctxPercent !== null ? `${ctxPercent.toFixed(1)}%` : "?"}
              <span className="text-ink-faint">
                {contextUsage?.contextWindow ? `/${compactTokens(contextUsage.contextWindow)}` : ""}
              </span>
            </span>
          </span>
        )}

        {cacheHit !== null && cacheHit > 0 && (
          <span className="flex shrink-0 items-center gap-1">
            <span>{t("usage.strip.cacheHit")}</span>
            <span className="font-medium text-ink">{cacheHit.toFixed(1)}%</span>
          </span>
        )}

        {quotaText && (
          <span className="flex min-w-0 items-center gap-1 truncate">
            <span className="text-ink-faint">{t("usage.strip.quota")}</span>
            <span className="truncate font-medium text-ink-soft">{quotaText}</span>
          </span>
        )}

        {/* 展开指示：整行都是点击区，箭头只做提示。 */}
        <svg
          width="8"
          height="8"
          viewBox="0 0 10 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className={`ml-auto shrink-0 transition-transform duration-150 ${
            open ? "rotate-180 text-ink-soft" : "text-ink-faint"
          }`}
        >
          <polyline points="2 3.5 5 6.5 8 3.5" />
        </svg>
      </button>

      <UsagePopover
        open={open}
        onClose={close}
        anchorRect={anchorRect}
        sessionStats={sessionStats}
        contextUsage={contextUsage}
        activity={activity}
        upstreamUsage={upstreamUsage}
        allUsages={allUsages}
        loading={loading}
        onRefresh={onRefresh}
      />
    </div>
  );
});
