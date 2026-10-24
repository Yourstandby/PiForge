"use client";

import { useEffect } from "react";
import { applyTheme, readStoredTheme, watchSystemTheme } from "@/lib/theme";

/**
 * 首屏已在 `app/layout.tsx` 的内联脚本里定过主题（防闪烁）；这里只做两件事：
 * 1. 挂载后按当前 localStorage 再校正一次（内联脚本被 CSP 拦住时兜底）；
 * 2. 偏好为「跟随系统」时监听系统主题切换。
 */
export function ThemeBoot() {
  useEffect(() => {
    const preference = readStoredTheme();
    applyTheme(preference);
    return watchSystemTheme(preference, () => applyTheme("system"));
  }, []);

  return null;
}
