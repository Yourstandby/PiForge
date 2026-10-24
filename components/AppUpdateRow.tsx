"use client";

/**
 * 「系统状态」弹层里的应用更新行（阶段八第 1 步）。
 *
 * 交互只有三条硬要求：
 * 1. 点击立刻有反应 —— 钩子做乐观更新，按钮当帧就变 `下载中 0%`；
 * 2. 永远给结论 —— 检查/下载失败都落到 `error` 文案 + 重试，不留空白；
 * 3. 不打断会话 —— 下载不阻塞输入，「重启安装」是显式按钮。
 */

import { useCallback, useEffect, useState } from "react";
import { ArrowUpCircle, Loader2, RotateCcw } from "lucide-react";
import type { AppUpdater } from "@/hooks/useAppUpdater";

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

const PRIMARY =
  "rounded-md bg-[#2563EB] px-2 py-[3px] text-[10.5px] font-medium text-white transition-colors hover:bg-[#1D4ED8] disabled:opacity-60";
const GHOST =
  "rounded-md px-1.5 py-[3px] text-[10px] text-[#6B7280] transition-colors hover:bg-[#ECECEF] hover:text-ink disabled:opacity-60";

export function AppUpdateRow({ updater }: { updater: AppUpdater }) {
  const { snapshot } = updater;
  const [archives, setArchives] = useState<string[]>([]);
  const loadArchives = updater.loadArchives;
  const phase = snapshot?.phase ?? "idle";

  // 依赖函数本身（钩子里是 useCallback，引用稳定），避免每渲染都打一次 IPC。
  useEffect(() => {
    void loadArchives().then(setArchives);
  }, [loadArchives, phase]);

  const rollbackVersion = archives.length > 0 ? archives[archives.length - 1] : null;
  const rollbackInstall = updater.rollback;
  const rollback = useCallback(
    async (version: string) => {
      if (typeof window !== "undefined" && !window.confirm(`回退到 v${version}？应用将退出并安装该版本（会话数据不受影响）。`)) {
        return;
      }
      const result = await rollbackInstall(version);
      if (!result.ok && typeof window !== "undefined") {
        window.alert(result.error ?? "回退失败");
      }
    },
    [rollbackInstall],
  );

  if (!updater.supported) {
    return <div className="mt-1 text-[10px] text-[#B4BAC5]">安装版可用（开发模式不检查更新）</div>;
  }

  if (!snapshot) {
    return <div className="mt-1 text-[10px] text-[#B4BAC5]">读取更新状态…</div>;
  }

  const version = snapshot?.version ?? "";
  const percent = Math.min(100, Math.max(0, snapshot?.percent ?? 0));
  const showRollback = rollbackVersion !== null && phase !== "downloading";

  return (
    <div className="mt-1 flex flex-col gap-1">
      {phase === "checking" && (
        <div className="flex items-center gap-1 text-[10.5px] text-[#6B7280]">
          <Loader2 size={10} className="animate-spin" aria-hidden="true" />
          正在检查更新…
        </div>
      )}

      {phase === "available" && (
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1 text-[10.5px] text-[#2563EB]">
            <ArrowUpCircle size={10} aria-hidden="true" />v{version}
          </span>
          <button type="button" className={PRIMARY} onClick={updater.download}>
            升级
          </button>
        </div>
      )}

      {phase === "downloading" && (
        <div className="flex flex-col gap-1">
          <div className="h-[3px] w-full overflow-hidden rounded-full bg-[#E8EFFB]">
            <div
              className="h-full rounded-full bg-[#2563EB] transition-[width] duration-200"
              style={{ width: `${percent}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-[10px] text-[#6B7280]">
            <span className="tabular-nums">
              {percent}% · {formatBytes(snapshot?.bytesPerSecond ?? 0)}/s
            </span>
            <span>可继续使用</span>
          </div>
        </div>
      )}

      {phase === "downloaded" && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10.5px] text-[#3E8A63]">v{version} 已就绪</span>
          <button type="button" className={PRIMARY} onClick={updater.install} disabled={snapshot?.busy}>
            重启安装
          </button>
        </div>
      )}

      {(phase === "idle" || phase === "up-to-date") && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10.5px] text-[#8B93A1]">
            {phase === "up-to-date" ? `已是最新${version ? ` v${version}` : ""}` : "检查应用更新"}
          </span>
          <button type="button" className={GHOST} onClick={updater.check}>
            检查
          </button>
        </div>
      )}

      {phase === "error" && (
        <div className="flex items-start justify-between gap-2">
          <span className="text-[10px] leading-[1.35] text-[#C2554E]">{snapshot?.error ?? "更新失败"}</span>
          <button type="button" className={GHOST} onClick={updater.check}>
            重试
          </button>
        </div>
      )}

      {showRollback && (
        <button
          type="button"
          onClick={() => void rollback(rollbackVersion)}
          className="flex items-center gap-1 self-start text-[10px] text-[#8B93A1] transition-colors hover:text-[#2563EB]"
          title={`留档 ${archives.length} 个版本，回退不动会话数据`}
        >
          <RotateCcw size={9} aria-hidden="true" />
          回退到 v{rollbackVersion}
        </button>
      )}
    </div>
  );
}

export default AppUpdateRow;
