"use client";

import { AlertTriangle, Coins, X } from "lucide-react";
import type { TokenGuardHint, TokenGuardKind } from "../lib/token-guard";

/**
 * Token 护栏（P2-2 / P2-3a）—— **纯提示层**。
 *
 * 数据来源都是只读的：`agent.state.contextUsage.tokens` 与 `agent.state.prefixAudit`
 * （由 Host 侧 `prompt-prefix.ts` 的既有审计产出）。这里不发请求、不改前缀、
 * 不写任何 token 相关状态；用户关掉就不再出现（本会话内）。
 *
 * 文案刻意写"可能/≈"：审计里这两类事件合计只占 6%，提示的价值是让用户看见，
 * 而不是承诺省钱。
 */
export function TokenGuardBanner({
  hints,
  onDismiss,
  onNewSession,
}: {
  hints: TokenGuardHint[];
  onDismiss: (kind: TokenGuardKind) => void;
  onNewSession?: () => void;
}) {
  if (hints.length === 0) return null;
  const hint = hints[0];

  const tone =
    hint.kind === "prefix-invalidated"
      ? { border: "border-[#F3D3A8]", background: "bg-[#FDF7EC]", text: "text-[#8A5A16]", icon: "text-[#C2831F]" }
      : hint.kind === "session-too-long"
        ? { border: "border-[#E1E6F0]", background: "bg-[#F7FAFF]", text: "text-[#3E4A5B]", icon: "text-[#5B8DEF]" }
        : { border: "border-[#DCE7F7]", background: "bg-[#F4F8FE]", text: "text-[#3E4A5B]", icon: "text-[#5B8DEF]" };

  const Icon = hint.kind === "prefix-invalidated" ? AlertTriangle : Coins;

  return (
    <div
      className={`mx-auto mb-2 flex w-full max-w-[860px] items-start gap-2 rounded-lg border px-3 py-2 text-[11.5px] leading-[1.5] ${tone.border} ${tone.background} ${tone.text}`}
      role="status"
      data-token-guard={hint.kind}
    >
      <Icon size={13} strokeWidth={2} className={`mt-0.5 shrink-0 ${tone.icon}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{hint.text}</div>
        {hint.detail && <div className="mt-0.5 text-[11px] opacity-80">{hint.detail}</div>}
      </div>
      {onNewSession && hint.kind === "prefix-invalidated" && (
        <button
          type="button"
          onClick={onNewSession}
          className="shrink-0 rounded-md border border-current/25 px-2 py-0.5 text-[11px] font-medium hover:bg-white/60"
        >
          开新会话
        </button>
      )}
      <button
        type="button"
        onClick={() => onDismiss(hint.kind)}
        aria-label="关闭提示"
        title="关闭（本会话内不再提示）"
        className="shrink-0 rounded-md p-0.5 opacity-60 hover:bg-white/60 hover:opacity-100"
      >
        <X size={12} strokeWidth={2} aria-hidden="true" />
      </button>
    </div>
  );
}
