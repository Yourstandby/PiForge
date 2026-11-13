"use client";

import { AlertTriangle } from "lucide-react";
import { describeRetryNotice, type RetryNoticeInput } from "../lib/retry-notice";

/**
 * 模型连接失败 / 自动重试的横幅。
 *
 * 数据只来自 `chat.retryInfo`（pi 的 `auto_retry_start` → reducer → hook），
 * 这里不发请求、不改状态。样式对齐 `TokenGuardBanner`，位置在输入框正上方：
 * 用户按下发送后视线就在那里，而不是去翻控制台。
 */
export function RetryNotice({ info }: { info?: RetryNoticeInput | null }) {
  const view = describeRetryNotice(info ?? null);
  if (!view) return null;

  return (
    <div
      role="status"
      data-model-retry=""
      className="flex w-full items-start gap-2 rounded-lg border border-[#F3D3A8] bg-[#FDF7EC] px-3 py-2 text-[11.5px] leading-[1.5] text-[#8A5A16]"
    >
      <AlertTriangle
        size={13}
        strokeWidth={2}
        className="mt-0.5 shrink-0 text-[#C2831F]"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{view.title}</div>
        {view.detail && <div className="mt-0.5 break-all text-[11px] opacity-80">{view.detail}</div>}
        {view.hint && <div className="mt-1 text-[11px]">{view.hint}</div>}
      </div>
    </div>
  );
}

export default RetryNotice;
