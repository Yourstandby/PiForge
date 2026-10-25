"use client";

import { AlertTriangle, PlugZap, Square } from "lucide-react";
import type { StreamHealth } from "@/hooks/agent-session/stream-health";

/**
 * 事件流健康提示 —— **只提示，不自动做决定**。
 *
 * 原来的行为：SSE 断了之后界面依旧显示「PiForge 正在思考…」，因为所有内容都靠
 * `agent_end → reloadSession` 从磁盘重载；用户不点「停止」，就永远看不到真正产生
 * 的结果。这里把「流已经不新鲜了」直接摆到输入框上方，并给出两个确定有效的出口：
 * 立即重连（host 从最后投递的序号续发，不丢增量）、或停止后从磁盘重载已产出的内容。
 */
export function StreamHealthBanner({
  health,
  onReconnect,
  onAbort,
}: {
  health: StreamHealth;
  onReconnect: () => void;
  onAbort: () => void;
}) {
  if (health.kind === "ok") return null;

  const stalled = health.kind === "stalled";
  const idleSeconds = stalled ? Math.round(health.idleMs / 1000) : 0;

  const text =
    health.kind === "failed"
      ? `与本地引擎的事件流已断开（已重连 ${health.attempts} 次），后台仍在继续重试。`
      : health.kind === "stalled"
        ? `已经 ${idleSeconds} 秒没有收到任何增量，事件流可能卡住了。`
        : `事件流重连中…（第 ${health.attempts} 次）`;

  const detail =
    health.kind === "failed"
      ? "本轮已产出的内容不会丢：重连成功后会补齐，或点「停止」直接从磁盘重载。"
      : health.kind === "stalled"
        ? "模型可能已经产出内容，只是没推到界面；点「停止」会先落盘再重载，能看到已有的部分。"
        : "若长时间停在这里，可以点「立即重连」跳过等待。";

  const tone = stalled
    ? { border: "border-[#F3D3A8]", background: "bg-[#FDF7EC]", text: "text-[#8A5A16]", icon: "text-[#C2831F]" }
    : { border: "border-[#E1E6F0]", background: "bg-[#F7FAFF]", text: "text-[#3E4A5B]", icon: "text-[#5B8DEF]" };

  return (
    <div
      className={`mx-auto flex w-full max-w-[860px] items-start gap-2 rounded-lg border px-3 py-2 text-[11.5px] leading-[1.5] ${tone.border} ${tone.background} ${tone.text}`}
      role="status"
      aria-live="polite"
      data-stream-health={health.kind}
    >
      <AlertTriangle size={13} strokeWidth={2} className={`mt-0.5 shrink-0 ${tone.icon}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{text}</div>
        <div className="mt-0.5 text-[11px] opacity-80">{detail}</div>
      </div>
      <button
        type="button"
        onClick={onReconnect}
        className="flex shrink-0 items-center gap-1 rounded-md border border-current/25 px-2 py-0.5 text-[11px] font-medium hover:bg-white/60"
      >
        <PlugZap size={11} strokeWidth={2} aria-hidden="true" />
        立即重连
      </button>
      <button
        type="button"
        onClick={onAbort}
        title="停止本轮并从磁盘重载已产出的内容"
        className="flex shrink-0 items-center gap-1 rounded-md border border-current/25 px-2 py-0.5 text-[11px] font-medium hover:bg-white/60"
      >
        <Square size={10} strokeWidth={2.5} aria-hidden="true" />
        停止
      </button>
    </div>
  );
}
