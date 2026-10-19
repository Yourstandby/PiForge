"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/components/I18nProvider";

/**
 * Session costs are reported in USD by the agent runtime. Chinese UI shows CNY
 * at the live reference rate (server-side cached proxy: /api/fx); every other
 * locale keeps the raw USD figure.
 */
export function useCurrency() {
  const { locale } = useI18n();
  const isCny = locale === "zh-CN";
  const [rate, setRate] = useState<number | null>(null);

  useEffect(() => {
    if (!isCny) return;
    let cancelled = false;
    fetch("/api/fx")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { rate?: number } | null) => {
        if (!cancelled && typeof data?.rate === "number" && data.rate > 0) {
          setRate(data.rate);
        }
      })
      .catch(() => {
        // Offline: fall back to USD rather than showing a wrong conversion.
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

  return { currency, rate, format, format4, isCny };
}
