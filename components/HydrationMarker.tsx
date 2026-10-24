"use client";

import { useEffect } from "react";

/**
 * Hydration 标记（冒烟用，无渲染输出）。
 *
 * 打包冒烟不能拿"正文有多少字"判断前端是否活着：全新用户配置（CI runner、
 * 第一次启动）下应用本来就停在"暂无项目"的空状态，正文只有 150 字左右，
 * 而 SSR 空壳也是 160 字 —— 两者靠字数根本分不开（v0.9.1 三个平台的假红
 * 就是这么来的：DOM 48 KB、chunk 全 200、正文 181 字，其实前端完全正常）。
 *
 * 这里在客户端挂载后打一个标记，冒烟断言"React 真的 hydrate 了"，
 * 与用户配置里有没有历史项目无关。
 */
export function HydrationMarker() {
  useEffect(() => {
    document.documentElement.dataset.piforgeHydrated = "1";
  }, []);
  return null;
}
