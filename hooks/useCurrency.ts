"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/components/I18nProvider";

/**
 * Session costs are reported in USD by the agent runtime. Chinese UI shows CNY
 * at the live reference rate (server-side cached proxy: /api/fx); every other
 * locale keeps the raw USD figure.
 */
/**
 * 汇率是全局数据，与组件实例无关：多个聊天分栏 / 多标签页共享同一次请求，
 * 避免首屏同时打出 N 个 /api/fx。服务端本身也有 30 分钟缓存。
 */
const fxStore = globalThis as typeof globalThis & {
  __piforgeFxPromise?: Promise<number | null>;
};

function loadFxRate(): Promise<number | null> {
  if (!fxStore.__piforgeFxPromise) {
    fxStore.__piforgeFxPromise = fetch("/api/fx")
      .then((res) => (res.ok ? (res.json() as Promise<{ rate?: number }>) : null))
      .then((data) => (typeof data?.rate === "number" && data.rate > 0 ? data.rate : null))
      .catch(() => null)
      .then((rate) => {
        // 失败时不要缓存死值，下次挂载再试
        if (rate === null) fxStore.__piforgeFxPromise = undefined;
        return rate;
      });
  }
  return fxStore.__piforgeFxPromise;
}

export function useCurrency() {
  const { locale } = useI18n();
  const isCny = locale === "zh-CN";
  const [rate, setRate] = useState<number | null>(null);

  useEffect(() => {
    if (!isCny) return;
    let cancelled = false;
    void loadFxRate().then((value) => {
      // Offline: fall back to USD rather than showing a wrong conversion.
      if (!cancelled && value !== null) setRate(value);
    });
    return () => {
      cancelled = true;
    };
  }, [isCny]);

  const currency: "CNY" | "USD" = isCny && rate !== null ? "CNY" : "USD";

  const format = (usd: number): string => {
    if (!Number.isFinite(usd)) return "$0.00";
    if (currency === "CNY" && rate !== null) {
      const cny = usd * rate;
      return cny >= 0.01 ? `¥${cny.toFixed(2)}` : "<¥0.01";
    }
    return usd >= 0.01 ? `$${usd.toFixed(2)}` : "<$0.01";
  };

  const format4 = (usd: number): string => {
    if (!Number.isFinite(usd)) return currency === "CNY" ? "¥0.00" : "$0.00";
    if (currency === "CNY" && rate !== null) {
      return `¥${(usd * rate).toFixed(4)}`;
    }
    return `$${usd.toFixed(4)}`;
  };

  const symbol = currency === "CNY" ? "¥" : "$";

  /**
   * 混合币种金额 → 显示币种数值。
   * USD 桶按实盘汇率折算；CNY 桶原样计入（模型按人民币报价时 pi 算出的数字
   * 本来就是人民币，再乘一次汇率就是重复换算）。
   */
  const toDisplayAmount = (usd: number, cny = 0): number => {
    const safeUsd = Number.isFinite(usd) ? usd : 0;
    const safeCny = Number.isFinite(cny) ? cny : 0;
    if (currency === "CNY" && rate !== null) return safeUsd * rate + safeCny;
    if (currency === "USD" && rate !== null) return safeUsd + safeCny / rate;
    return safeUsd + safeCny;
  };

  /** 会话成本（分币种分桶）的展示口径：不做 <0.01 截断，固定小数位。 */
  const formatCost = (cost: { usd?: number; cny?: number } | number, digits = 4): string => {
    const usd = typeof cost === "number" ? cost : cost.usd ?? 0;
    const cny = typeof cost === "number" ? 0 : cost.cny ?? 0;
    const value = toDisplayAmount(usd, cny);
    if (!Number.isFinite(value)) return symbol + "0.0000";
    return symbol + value.toFixed(digits);
  };

  return { currency, rate, symbol, format, format4, formatCost, toDisplayAmount, isCny };
}
