"use client";

import type { CSSProperties, ReactNode } from "react";
import { visibleErrorMessage } from "@/lib/ui-error";

export interface ErrorNoticeProps {
  /** Raw message from a fetch / API / host call. */
  message?: string | null;
  className?: string;
  style?: CSSProperties;
  /** Rendered instead when the message is transport noise (pipe/socket). */
  fallback?: ReactNode;
  role?: "alert" | "status";
}

/**
 * 统一的错误展示入口。
 *
 * 任何「错误状态」都不要直接 `{error}`：Agent Host 命名管道还没就绪时，
 * 底层会抛 `connect ENOENT \\.\pipe\piforge-agent-…`，那不是用户能处理的错，
 * 直接画成红字只会让人觉得应用崩了。这里统一走 `visibleErrorMessage`：
 * 业务错误原样显示，传输层噪声隐藏（可用 fallback 换成柔和的等待文案），
 * 开发环境 + debug 标志下仍可见原文。
 */
export function ErrorNotice({
  message,
  className,
  style,
  fallback = null,
  role = "alert",
}: ErrorNoticeProps) {
  const detail = visibleErrorMessage(message);
  if (!detail) return <>{fallback}</>;
  return (
    <span role={role} className={className} style={style}>
      {detail}
    </span>
  );
}

export default ErrorNotice;
