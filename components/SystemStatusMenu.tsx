"use client";

/**
 * 标题栏右侧的「系统状态」按钮（A 方案：把底栏的引擎点 + pi 核心版本搬上来）。
 *
 * 这些都是会话无关的低频信息，却和底栏右侧的余额抢宽度：引擎点会脉冲、
 * 版本文字在 640px 临界跳动，余额就被挤到末尾甚至触发横向滚动。
 * 放到标题栏后，底栏左簇只剩会话操作，余额拿到稳定预算。
 *
 * 数据来源全部复用现有单例：`useHostHealth` 是模块级共享轮询（不新增请求），
 * `UpstreamVersionBadge` 自带 idle 拉取，但只在弹层挂载时才开始 —— 打不开就不查。
 */
import { memo, useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Activity } from "lucide-react";
import { useHostHealth, type HostEngineState } from "@/hooks/useHostHealth";
import { useDismissOnOutsideClick } from "@/hooks/useDismissOnOutsideClick";
import { UpstreamVersionBadge } from "./UpstreamVersionBadge";

const DOT_COLOR: Record<HostEngineState, string> = {
  ready: "#22C55E",
  reconnecting: "#F59E0B",
  offline: "#EF4444",
  unknown: "#C7CBD3",
};

const STATE_LABEL: Record<HostEngineState, string> = {
  ready: "引擎正常",
  reconnecting: "引擎重连中",
  offline: "引擎离线",
  unknown: "引擎状态未知",
};

function formatUptime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-[10px] text-[#9AA1AC]">{label}</dt>
      <dd className="truncate font-mono text-[10.5px] tabular-nums text-[#4B5563]">{value}</dd>
    </div>
  );
}

/** 弹层宽度（与卡片 `w-[238px]` 保持一致，定位要用它算左右边界）。 */
const PANEL_WIDTH = 238;
/** 距离窗口边缘的安全间距。 */
const VIEWPORT_MARGIN = 8;

export const SystemStatusMenu = memo(function SystemStatusMenu() {
  const health = useHostHealth();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismissOnOutsideClick([containerRef, panelRef], open, close);

  /**
   * 弹层走 portal + fixed 定位。
   *
   * 以前是标题栏里的 `absolute right-0`：标题栏只有 36px 高、还带
   * `backdrop-blur`（会生成包含块），一旦祖先容器有裁剪或宽度异常，卡片就会
   * 被切掉一半、甚至跑到窗口左侧外面（"显示不全"）。portal 之后只按按钮的
   * 实际矩形算位置，并且始终夹在视口内。
   */
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const anchor = containerRef.current?.getBoundingClientRect();
    const panel = panelRef.current?.getBoundingClientRect();
    if (!anchor) return;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const width = panel?.width || PANEL_WIDTH;
    const height = panel?.height || 0;
    let left = anchor.right - width;
    left = Math.max(VIEWPORT_MARGIN, Math.min(left, viewportWidth - width - VIEWPORT_MARGIN));
    let top = anchor.bottom + 6;
    if (height > 0 && top + height > viewportHeight - VIEWPORT_MARGIN) {
      // 下方放不下就翻到按钮上方，仍然夹在视口内。
      top = Math.max(VIEWPORT_MARGIN, anchor.top - height - 6);
    }
    setPosition((previous) =>
      previous && Math.abs(previous.left - left) < 0.5 && Math.abs(previous.top - top) < 0.5
        ? previous
        : { left, top },
    );
  }, [open, health.detail, health.state]);

  const label = STATE_LABEL[health.state];
  const detail = health.detail;

  return (
    <div
      ref={containerRef}
      className="relative flex items-center [-webkit-app-region:no-drag]"
    >
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        title={`${label} · 查看引擎与核心版本`}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`relative flex h-6 w-6 items-center justify-center rounded-md transition-colors duration-150 ${
          open ? "bg-[#E8EFFB] text-accent-strong" : "text-ink-faint hover:bg-[#ECECEF] hover:text-ink"
        }`}
      >
        <Activity size={13} strokeWidth={1.8} aria-hidden="true" />
        <span
          aria-hidden="true"
          className="absolute right-0.5 top-0.5 h-[5px] w-[5px] rounded-full ring-1 ring-white"
          style={{ backgroundColor: DOT_COLOR[health.state] }}
        />
      </button>

      {open && createPortal(
        <div
          ref={panelRef}
          role="dialog"
          aria-label="引擎与版本"
          style={{
            left: position?.left ?? 0,
            top: position?.top ?? 0,
            width: PANEL_WIDTH,
            visibility: position ? "visible" : "hidden",
          }}
          className="fixed z-[1000] rounded-xl border border-[#E4E6EB] bg-white p-3 shadow-[0_16px_36px_-12px_rgba(15,23,42,0.28),0_1px_2px_rgba(15,23,42,0.06)] [-webkit-app-region:no-drag]"
        >
          <div className="text-[10px] font-semibold tracking-[0.02em] text-[#9AA1AC]">后台引擎</div>
          <div className="mt-1 flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="h-[6px] w-[6px] shrink-0 rounded-full"
              style={{ backgroundColor: DOT_COLOR[health.state] }}
            />
            <span className="text-[12px] font-semibold text-[#1F2937]">{label}</span>
          </div>
          <div className="mt-0.5 truncate text-[10.5px] text-[#8B93A1]" title={health.message}>
            {health.message}
          </div>

          {detail && (
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 border-t border-[#EFF0F3] pt-2">
              <Metric label="PID" value={detail.pid} />
              <Metric label="运行" value={formatUptime(detail.uptimeMs)} />
              <Metric label="会话" value={detail.sessions} />
              <Metric label="进程" value={detail.processes} />
            </dl>
          )}

          <div className="mt-2 border-t border-[#EFF0F3] pt-2">
            <div className="text-[10px] font-semibold tracking-[0.02em] text-[#9AA1AC]">核心版本</div>
            <div className="mt-1 flex items-center justify-between gap-2">
              <UpstreamVersionBadge />
              <span className="text-[10px] text-[#B4BAC5]">稳定通道</span>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
});

export default SystemStatusMenu;
