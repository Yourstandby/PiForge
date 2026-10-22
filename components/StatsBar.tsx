"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "./I18nProvider";
import { useUpstreamUsage } from "@/hooks/useUpstreamUsage";
import { useDismissOnOutsideClick } from "@/hooks/useDismissOnOutsideClick";
import { useCurrency } from "@/hooks/useCurrency";
import { UsagePopover } from "./UsagePopover";
import { subscribeLiveUsage } from "@/lib/live-usage";

import type { SessionActivity, SessionStats } from "@/hooks/agent-session/session-stats";
import type { ContextUsage } from "@/lib/pi-types";

export type { SessionActivity, SessionStats, ContextUsage };

export interface StatsBarProps {
  showChat: boolean;
  sessionStats?: SessionStats | null;
  contextUsage?: ContextUsage | null;
  /** 回合数 + 工具调用汇总；缺省时不渲染对应的标签。 */
  activity?: SessionActivity | null;
  /** 聊天面板窄于 640px：只保留核心数据（费用 / 回合），隐藏工具调用细节。 */
  compact?: boolean;
  currentProvider?: string | null;
}

export const StatsBar = React.memo(function StatsBar({
  showChat,
  sessionStats = null,
  contextUsage = null,
  activity = null,
  compact = false,
  currentProvider = null,
}: StatsBarProps) {
  const { t } = useI18n();
  const { format: formatMoney } = useCurrency();
  const [popoverOpen, setPopoverOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

  const {
    usages,
    currentUsage,
    loading: upstreamLoading,
    refresh: refreshUpstream,
  } = useUpstreamUsage(currentProvider);

  /**
   * 自适应披露：状态栏被右侧面板挤窄时，逐个隐掉次要指标，
   * 而不是让 flex 把整块裁到看不见（之前 ↑127k ↓133k / turn 会整体消失）。
   * 以 chip 自身宽度为准（它 min-w-0 可压缩，宽度≈可用宽度）。
   */
  const chipRef = useRef<HTMLButtonElement>(null);
  const [chipWidth, setChipWidth] = useState(0);
  useEffect(() => {
    const el = chipRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      setChipWidth(entries[0]?.contentRect.width ?? el.clientWidth);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // 0 = 尚未测量：先按最完整的内容渲染，测完再收敛。
  // 小屏（compact）阈值更狠：只留「金额 + 回合」这两个核心数字。
  // 注意：额度/余额已经拆到右侧固定区，不再是这个 chip 的一部分（宽约 112px），
  // 所以阈值相应下调，保证同样的面板宽度下展示的指标与以前一致。
  const tokenThreshold = compact ? 180 : 150;
  const showTokens = chipWidth === 0 ? !compact : chipWidth >= tokenThreshold;
  const showCache = chipWidth === 0 ? !compact : chipWidth >= (compact ? 240 : 225);
  const showContext = chipWidth === 0 ? !compact : chipWidth >= (compact ? 280 : 265);

  /**
   * 流式期间让「↓ 输出」「费用」数字原地跳动：
   * 直接改 ref 指向的文本节点，不走 setState，因此不会重渲染界面。
   * 位置必须在任何 early return 之前（hooks 顺序）。
   */
  const outputRef = useRef<HTMLSpanElement>(null);
  const costRef = useRef<HTMLSpanElement>(null);
  const baseOutput = sessionStats?.tokens?.output ?? 0;
  const baseCost = sessionStats?.cost ?? 0;

  useEffect(() => {
    const formatTokens = (value: number) =>
      value >= 1_000_000
        ? `${(value / 1_000_000).toFixed(1)}M`
        : value >= 1000
          ? `${(value / 1000).toFixed(0)}k`
          : String(value);
    /** 数字变化时闪一下品牌蓝（Web Animations，零重渲染）。 */
    const flash = (el: HTMLElement | null) => {
      if (!el || typeof el.animate !== "function") return;
      el.animate(
        [
          { color: "#2563eb", offset: 0 },
          { color: "#2563eb", offset: 0.25 },
          { color: "currentColor", offset: 1 },
        ],
        { duration: 420, easing: "ease-out" },
      );
    };
    const setText = (el: HTMLElement | null, text: string) => {
      if (!el || el.textContent === text) return;
      el.textContent = text;
      flash(el);
    };
    const restore = () => {
      setText(outputRef.current, baseOutput > 0 ? formatTokens(baseOutput) : "");
      setText(costRef.current, baseCost > 0 ? formatMoney(baseCost) : "");
    };
    restore();
    return subscribeLiveUsage((live) => {
      if (!live || live.tokens <= 0) {
        restore();
        return;
      }
      setText(outputRef.current, formatTokens(baseOutput + live.tokens));
      const liveCost = baseCost + live.cost;
      setText(costRef.current, liveCost > 0 ? formatMoney(liveCost) : "");
    });
  }, [baseOutput, baseCost, formatMoney]);


  const togglePopover = useCallback(() => {
    if (containerRef.current) {
      setAnchorRect(containerRef.current.getBoundingClientRect());
    }
    setPopoverOpen((prev) => !prev);
  }, []);

  const closePopover = useCallback(() => {
    setPopoverOpen(false);
  }, []);

  useDismissOnOutsideClick(containerRef, popoverOpen, closePopover);

  const hasActivity = Boolean(
    activity && (activity.turns > 0 || activity.toolCalls.total > 0),
  );

  if (
    !showChat ||
    (!sessionStats && !contextUsage && !currentUsage && usages.length === 0 && !hasActivity)
  ) {
    return null;
  }

  const tks = sessionStats?.tokens;
  const c = sessionStats?.cost ?? 0;
  const fmt = (n: number) =>
    n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(1)}M`
      : n >= 1000
      ? `${(n / 1000).toFixed(0)}k`
      : String(n);
  const costStr = c > 0 ? formatMoney(c) : null;



  // Calculate cache hit rate if available or derivable
  const cacheHitRate =
    sessionStats?.cacheHitRate != null && Number.isFinite(sessionStats.cacheHitRate)
      ? sessionStats.cacheHitRate
      : tks && (tks.input + tks.cacheRead + tks.cacheWrite > 0) && tks.cacheRead > 0
      ? (tks.cacheRead / (tks.input + tks.cacheRead + tks.cacheWrite)) * 100
      : null;

  let ctxColor = "var(--text-muted)";
  let ctxStr: string | null = null;
  if (contextUsage?.contextWindow) {
    const pct = contextUsage.percent;
    if (pct !== null && pct > 90) ctxColor = "var(--danger)";
    else if (pct !== null && pct > 70) ctxColor = "var(--warning)";
    const pctStr = pct !== null ? `${pct.toFixed(1)}%` : "?";
    ctxStr = `${pctStr}/${fmt(contextUsage.contextWindow)} ${t("usage.auto")}`;
  }

  const tooltipParts: string[] = [];
  if (tks) {
    tooltipParts.push(t("usage.tooltip.in", { count: tks.input.toLocaleString() }));
    tooltipParts.push(t("usage.tooltip.out", { count: tks.output.toLocaleString() }));
    if (tks.reasoning != null && tks.reasoning > 0) {
      tooltipParts.push(t("usage.tooltip.reasoning", { count: tks.reasoning.toLocaleString() }));
    }
    tooltipParts.push(t("usage.tooltip.cacheRead", { count: tks.cacheRead.toLocaleString() }));
    tooltipParts.push(t("usage.tooltip.cacheWrite", { count: tks.cacheWrite.toLocaleString() }));
    if (cacheHitRate !== null) {
      tooltipParts.push(t("usage.tooltip.cacheHit", { rate: cacheHitRate.toFixed(1) }));
    }
    if (c > 0) {
      tooltipParts.push(t("usage.tooltip.cost", { cost: c.toFixed(4) }));
    }
  }
  if (contextUsage?.contextWindow) {
    const pct = contextUsage.percent;
    tooltipParts.push(
      t("usage.tooltip.context", {
        percent: pct !== null ? `${pct.toFixed(1)}%` : "?",
        total: contextUsage.contextWindow.toLocaleString(),
      })
    );
  }
  if (currentUsage) {
    tooltipParts.push(t("usage.tooltip.quota", { name: currentUsage.providerName }));
  }
  // 工具调用明细：窄宽度下 chip 里会隐藏，但完整列表始终保留在 title 里。
  const toolSummary =
    activity && activity.toolCalls.total > 0
      ? activity.toolCalls.byTool
          .map((tool) => `${tool.errors > 0 ? "✗" : "✓"} ${tool.name} x${tool.count}`)
          .join(" · ")
      : null;
  if (toolSummary) tooltipParts.push(toolSummary);
  tooltipParts.push(t("usage.title"));
  const tooltip = tooltipParts.join("  |  ");

  const isSubOrOAuth = Boolean(
    currentUsage &&
      (currentUsage.provider === "openai-codex" ||
        currentUsage.provider === "anthropic" ||
        (currentUsage.planType && /sub|plus|pro|team|enterprise/i.test(currentUsage.planType)))
  );

  /** 右侧额度/余额区是否有内容：决定它是否占住固定的 min-w（不跳宽）。 */
  const hasQuota = Boolean(
    currentUsage &&
      ((currentUsage.windows?.length ?? 0) > 0 ||
        (currentUsage.balance?.length ?? 0) > 0 ||
        currentUsage.rawLimit?.remaining != null ||
        isSubOrOAuth),
  );

  return (
    <div ref={containerRef} className="relative flex min-w-0 items-stretch [-webkit-app-region:no-drag]">
      <button
        ref={chipRef}
        type="button"
        onClick={togglePopover}
        title={tooltip}
        aria-label={t("usage.title")}
        aria-haspopup="dialog"
        aria-expanded={popoverOpen}
        className={`flex min-h-7 min-w-0 max-w-full flex-nowrap items-center justify-end gap-x-2 overflow-hidden whitespace-nowrap border-none px-2.5 py-0.5 font-mono text-[11px] tabular-nums select-none cursor-pointer transition-colors duration-150 ${
          popoverOpen
            ? "bg-bg-selected text-text border-t-2 border-t-accent"
            : "bg-transparent text-text-muted hover:text-text hover:bg-bg-hover/60 border-t-2 border-t-transparent"
        }`}
      >
        {showTokens && tks && tks.input > 0 && (
          <span className="flex shrink-0 items-center gap-0.5">
            <span className="text-accent font-semibold">↑</span>
            <span>{fmt(tks.input)}</span>
          </span>
        )}
        {showTokens && tks && tks.output > 0 && (
          <span className="flex shrink-0 items-center gap-0.5">
            <span className="text-info font-semibold">↓</span>
            <span ref={outputRef}>{fmt(tks.output)}</span>
          </span>
        )}
        {showCache && tks && tks.cacheRead > 0 && (
          <span className="flex shrink-0 items-center gap-0.5">
            <span className="text-success font-semibold">R</span>
            <span>{fmt(tks.cacheRead)}</span>
          </span>
        )}
        {showCache && tks && tks.cacheWrite > 0 && (
          <span className="flex shrink-0 items-center gap-0.5">
            <span className="text-warning font-semibold">W</span>
            <span>{fmt(tks.cacheWrite)}</span>
          </span>
        )}
        {showCache && cacheHitRate !== null && cacheHitRate > 0 && (
          <span className="flex shrink-0 items-center gap-0.5">
            <span className="text-text-dim">CH</span>
            <span className="font-medium text-text">{cacheHitRate.toFixed(1)}%</span>
          </span>
        )}
        {costStr && (
          <span className="shrink-0 font-medium text-text" title={toolSummary ?? undefined}>
            <span ref={costRef}>{costStr}</span>
          </span>
        )}
        {showContext && ctxStr && (
          <span className="flex shrink-0 items-center gap-1" style={{ color: ctxColor }}>
            <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 9 L1 5 Q1 1 5 1 Q9 1 9 5 L9 9" />
              <line x1="1" y1="9" x2="9" y2="9" />
            </svg>
            <span>{ctxStr}</span>
          </span>
        )}

        {/* 回合数：核心数据，任何宽度都保留、不换行、不被压缩 */}
        {activity && activity.turns > 0 && (
          <span className="flex shrink-0 items-center gap-0.5 whitespace-nowrap text-xs text-text-dim" title={toolSummary ?? undefined}>
            <span>{activity.turns}</span>
            <span>turn</span>
          </span>
        )}
        {/* 工具调用明细：渐进隐藏。
            - 视口 < md(768px) 时隐藏
            - 聊天面板 < 640px（compact）时也隐藏
            完整列表仍保留在按钮 / 费用 / 回合的 title 上。 */}
        {activity && activity.toolCalls.total > 0 && (
          <span
            className={`min-w-0 items-center gap-x-1.5 overflow-hidden whitespace-nowrap text-xs text-text-dim ${
              compact ? "hidden" : "hidden md:flex"
            }`}
            title={toolSummary ?? undefined}
            data-testid="stats-tool-calls"
          >
            {activity.toolCalls.byTool.slice(0, 2).map((tool) => (
              <span key={tool.name} className="flex shrink-0 items-center gap-0.5">
                <span className={tool.errors > 0 ? "text-danger" : "text-success"}>
                  {tool.errors > 0 ? "✗" : "✓"}
                </span>
                <span className="max-w-[72px] truncate">{tool.name}</span>
                <span>x{tool.count}</span>
              </span>
            ))}
            {activity.toolCalls.byTool.length > 2 && (
              <span className="shrink-0 text-text-dim">
                +{activity.toolCalls.byTool.length - 2}
              </span>
            )}
          </span>
        )}

        {/* Token / 费用 / 回合 / 工具明细。这一块允许被压缩：宽度不足时先隐掉
            次要指标（见 showTokens/showCache/showContext），金额与回合不裁不换行。 */}
      </button>

      {/* 额度 / 余额：固定宽度右侧区（B 方案）。shrink-0 + min-w + tabular-nums，
          右边永远对齐、数字变化不拉宽整行，也不会再把余额挤到末尾。 */}
      <button
        type="button"
        onClick={togglePopover}
        title={tooltip}
        aria-label={t("usage.title")}
        aria-haspopup="dialog"
        aria-expanded={popoverOpen}
        className={`flex min-h-7 shrink-0 items-center justify-end gap-1 whitespace-nowrap border-none border-l border-divider py-0.5 font-mono text-[11px] tabular-nums select-none cursor-pointer transition-colors duration-150 ${
          hasQuota ? "min-w-[112px] pl-2 pr-1.5" : "px-1.5"
        } ${
          popoverOpen
            ? "bg-bg-selected text-text border-t-2 border-t-accent"
            : "bg-transparent text-text-muted hover:text-text hover:bg-bg-hover/60 border-t-2 border-t-transparent"
        }`}
      >
        {/* Upstream Quota Mini Pill */}
        {currentUsage && currentUsage.windows && currentUsage.windows.length > 0 && (
          <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-control bg-bg-elevated border border-border text-[10px] text-text-muted font-normal">
            <span className="text-text font-medium">{currentUsage.providerName}</span>
            {isSubOrOAuth && (
              <span className="text-accent font-medium text-[9px]">{t("usage.sub")}</span>
            )}
            {currentUsage.windows.slice(0, 2).map((win, idx) => {
              const label =
                win.id === "5h" || win.label === "5h"
                  ? "5h"
                  : win.id === "7d" || win.label === "7d"
                  ? "7d"
                  : win.id === "daily_free" || win.label === "Daily Free Requests"
                  ? t("usage.dailyFree")
                  : (win.id ?? win.label);
              const colorClass =
                win.usedPercent > 90
                  ? "text-danger font-medium"
                  : win.usedPercent > 70
                  ? "text-warning font-medium"
                  : "text-text";
              return (
                <span key={idx} className="flex items-center gap-0.5">
                  <span className="text-text-dim">{label}:</span>
                  <span className={colorClass}>{win.usedPercent}%</span>
                  {idx < Math.min(2, currentUsage.windows!.length) - 1 && (
                    <span className="text-text-dim">|</span>
                  )}
                </span>
              );
            })}
          </span>
        )}

        {currentUsage && (!currentUsage.windows || currentUsage.windows.length === 0) && currentUsage.balance && currentUsage.balance.length > 0 && (
          <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-control bg-bg-elevated border border-border text-[10px] text-text-muted font-normal">
            <span className="text-text font-medium">{currentUsage.providerName}</span>
            {isSubOrOAuth && (
              <span className="text-accent font-medium text-[9px]">{t("usage.sub")}</span>
            )}
            <span className="text-text">{currentUsage.balance[0].currency}{currentUsage.balance[0].total}</span>
          </span>
        )}

        {currentUsage &&
          (!currentUsage.windows || currentUsage.windows.length === 0) &&
          (!currentUsage.balance || currentUsage.balance.length === 0) &&
          currentUsage.rawLimit?.remaining != null &&
          Number.isFinite(Number(currentUsage.rawLimit.remaining)) && (
            <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-control bg-bg-elevated border border-border text-[10px] text-text-muted font-normal">
              <span className="text-text font-medium">{currentUsage.providerName}</span>
              {isSubOrOAuth && (
                <span className="text-accent font-medium text-[9px]">{t("usage.sub")}</span>
              )}
              <span className="text-text">${currentUsage.rawLimit.remaining}</span>
            </span>
        )}

        {currentUsage &&
          (!currentUsage.windows || currentUsage.windows.length === 0) &&
          (!currentUsage.balance || currentUsage.balance.length === 0) &&
          currentUsage.rawLimit?.remaining == null &&
          !currentUsage.error &&
          isSubOrOAuth && (
            <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-control bg-bg-elevated border border-border text-[10px] text-text-muted font-normal">
              <span className="text-text font-medium">{currentUsage.providerName}</span>
              <span className="text-accent font-medium text-[9px]">{t("usage.sub")}</span>
            </span>
        )}

        {/* Subtle Chevron indicator */}
        <svg
          width="8"
          height="8"
          viewBox="0 0 10 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`transition-transform duration-150 text-text-dim ${
            popoverOpen ? "rotate-180 text-text" : ""
          }`}
        >
          <polyline points="2 3.5 5 6.5 8 3.5" />
        </svg>
      </button>

      <UsagePopover
        open={popoverOpen}
        onClose={closePopover}
        anchorRect={anchorRect}
        sessionStats={sessionStats}
        contextUsage={contextUsage}
        activity={activity}
        upstreamUsage={currentUsage}
        allUsages={usages}
        loading={upstreamLoading}
        onRefresh={refreshUpstream}
      />
    </div>
  );
});
