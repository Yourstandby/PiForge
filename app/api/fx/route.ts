import { NextResponse } from "../../../lib/next-server-shim.ts";

/**
 * USD → CNY reference rate for the cost readout.
 *
 * The client cannot call exchange-rate APIs directly: the CSP only allows
 * `connect-src 'self'` plus the loopback server. So the fetch happens here and
 * the answer is cached in-process for 30 minutes; when the upstream is
 * unreachable (offline desktop, blocked network) we fall back to the last known
 * good rate, then to a conservative constant.
 */

const CACHE_TTL_MS = 30 * 60 * 1000;
const FALLBACK_RATE = 7.1;
const UPSTREAM = "https://open.er-api.com/v6/latest/USD";

interface FxCache {
  rate: number;
  fetchedAt: number;
  source: "live" | "fallback";
}

const globalRef = globalThis as typeof globalThis & {
  __piforgeFxRateCache?: FxCache;
};

export const dynamic = "force-dynamic";

async function fetchRate(): Promise<FxCache> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(UPSTREAM, {
      signal: controller.signal,
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const data = (await res.json()) as { rates?: { CNY?: number } };
    const rate = data.rates?.CNY;
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
      throw new Error("missing CNY rate");
    }
    return { rate, fetchedAt: Date.now(), source: "live" };
  } finally {
    clearTimeout(timer);
  }
}

export async function GET() {
  const cached = globalRef.__piforgeFxRateCache;
  const fresh = cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS;
  if (fresh) {
    return NextResponse.json(cached);
  }

  try {
    const next = await fetchRate();
    globalRef.__piforgeFxRateCache = next;
    return NextResponse.json(next);
  } catch {
    // Keep serving the last good rate; only fall back to the constant if none.
    const fallback: FxCache = cached
      ? { ...cached, source: "fallback" }
      : { rate: FALLBACK_RATE, fetchedAt: Date.now(), source: "fallback" };
    globalRef.__piforgeFxRateCache = fallback;
    return NextResponse.json(fallback);
  }
}
