"use client";

import { useEffect, useState } from "react";

/**
 * L-B 实验开关（`PIFORGE_SESSION_SPLIT_HINT`）的渲染层视图。
 *
 * 为什么不一进页面就 fetch：这个开关只影响"会话过长时要不要给动作按钮"，
 * 属于非关键路径；页面首屏不该为它多打一次 API。所以由调用方在**需要时**
 * 才订阅（默认 `false` = 与引入前一致），并且结果在模块级缓存（一个进程只查一次）。
 */
let cached: boolean | null = null;
let inflight: Promise<boolean> | null = null;

async function fetchFlag(): Promise<boolean> {
  if (cached !== null) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      const data = (await res.json()) as { flags?: { sessionSplitHint?: boolean } };
      cached = data.flags?.sessionSplitHint === true;
    } catch {
      // 拿不到就当关闭：宁可少一个按钮，也不要因为实验开关把提示搞坏。
      cached = false;
    } finally {
      inflight = null;
    }
    return cached ?? false;
  })();
  return inflight;
}

export function useSessionSplitHint(enabled = true): boolean {
  const [flag, setFlag] = useState<boolean>(cached ?? false);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void fetchFlag().then((value) => {
      if (!cancelled) setFlag(value);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return flag;
}

/** 测试用：清掉模块级缓存。 */
export function resetSessionSplitHintCacheForTest(): void {
  cached = null;
  inflight = null;
}
