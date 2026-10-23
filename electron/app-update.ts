/**
 * 应用自动更新（阶段八第 1 步）的纯逻辑层。
 *
 * 设计取舍：
 * - **Main 主导**：更新源固定来自打包时生成的 `app-update.yml`（铁律：运行时绝不
 *   `setFeedURL`）。这里刻意不 import electron，`main.ts` 只把 autoUpdater 事件
 *   翻译成 `UpdateEvent` 再 `reduceUpdate`，因此状态迁移可以用 node:test 直接测。
 * - **点击即走**：`download-start` 立刻把相位切到 `downloading`（percent=0），渲染侧
 *   再加一次乐观更新，用户在 100ms 内就能看到变化，不会"点了没反应"。
 * - **快速失败**：超时 / 停滞由 main 侧计时器判定并投递 `error`，状态机本身不挂起。
 * - **可回退**：下载完成的安装包留档到 userData/updates，最多 3 份，供随时降级。
 */

export type UpdatePhase =
  | "unsupported"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

export interface UpdateSnapshot {
  phase: UpdatePhase;
  /** 更新源宣告的目标版本（available / downloading / downloaded 时有值）。 */
  version: string | null;
  /** 下载进度 0–100，仅 downloading 阶段有意义。 */
  percent: number;
  bytesPerSecond: number;
  totalBytes: number;
  error: string | null;
  /** 最近一次**广播**的时间戳；节流依赖它累积时间差。 */
  changedAt: number;
  /** 用户触发的操作是否在飞（按钮禁用、防重复点击）。 */
  busy: boolean;
}

export type UpdateEvent =
  | { type: "check-start"; at: number }
  | { type: "not-available"; version: string | null; at: number }
  | { type: "available"; version: string; at: number }
  | { type: "download-start"; at: number }
  | {
      type: "download-progress";
      percent: number;
      bytesPerSecond: number;
      totalBytes: number;
      at: number;
    }
  | { type: "downloaded"; version: string; at: number }
  | { type: "error"; message: string; at: number }
  | { type: "install"; at: number };

export function createSnapshot(at = 0): UpdateSnapshot {
  return {
    phase: "idle",
    version: null,
    percent: 0,
    bytesPerSecond: 0,
    totalBytes: 0,
    error: null,
    changedAt: at,
    busy: false,
  };
}

/** 非打包环境（`npm run dev:electron`）没有 app-update.yml，UI 需明确说明。 */
export function unsupportedSnapshot(at = 0): UpdateSnapshot {
  return { ...createSnapshot(at), phase: "unsupported" };
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return Math.round(value * 10) / 10;
}

/**
 * 纯状态迁移。返回 `prev` 本身表示"无变化"，调用方据此跳过广播。
 */
export function reduceUpdate(prev: UpdateSnapshot, event: UpdateEvent): UpdateSnapshot {
  switch (event.type) {
    case "check-start":
      if (prev.phase === "downloading" || prev.phase === "downloaded") return prev;
      return {
        ...prev,
        phase: "checking",
        error: null,
        busy: true,
        changedAt: event.at,
      };

    case "not-available":
      if (prev.phase === "downloading" || prev.phase === "downloaded") return prev;
      return {
        ...prev,
        phase: "up-to-date",
        version: event.version ?? prev.version,
        percent: 0,
        bytesPerSecond: 0,
        totalBytes: 0,
        error: null,
        busy: false,
        changedAt: event.at,
      };

    case "available":
      // 下载中/已下载时，重复的 available 事件不能把进度打回起点。
      if (prev.phase === "downloading" || prev.phase === "downloaded") {
        return prev.version === event.version ? prev : { ...prev, version: event.version };
      }
      return {
        ...prev,
        phase: "available",
        version: event.version,
        percent: 0,
        bytesPerSecond: 0,
        totalBytes: 0,
        error: null,
        busy: false,
        changedAt: event.at,
      };

    case "download-start":
      if (prev.phase === "downloaded") return prev;
      return {
        ...prev,
        phase: "downloading",
        percent: 0,
        bytesPerSecond: 0,
        totalBytes: 0,
        error: null,
        busy: true,
        changedAt: event.at,
      };

    case "download-progress":
      return {
        ...prev,
        phase: "downloading",
        percent: clampPercent(event.percent),
        bytesPerSecond: Math.max(0, Math.round(event.bytesPerSecond) || 0),
        totalBytes: Math.max(0, Math.round(event.totalBytes) || 0),
        busy: true,
        changedAt: event.at,
      };

    case "downloaded":
      return {
        ...prev,
        phase: "downloaded",
        version: event.version || prev.version,
        percent: 100,
        bytesPerSecond: 0,
        error: null,
        busy: false,
        changedAt: event.at,
      };

    case "error":
      return {
        ...prev,
        phase: "error",
        error: event.message,
        bytesPerSecond: 0,
        busy: false,
        changedAt: event.at,
      };

    case "install":
      return { ...prev, busy: true, changedAt: event.at };

    default:
      return prev;
  }
}

/** 进度事件节流：整百分点变化或超过 minIntervalMs 才广播，避免刷爆 IPC。 */
export function shouldEmitProgress(
  prev: UpdateSnapshot,
  next: UpdateSnapshot,
  minIntervalMs = 400,
): boolean {
  if (prev.phase !== "downloading") return true;
  if (next.percent >= 100) return true;
  if (Math.abs(next.percent - prev.percent) >= 1) return true;
  return next.changedAt - prev.changedAt >= minIntervalMs;
}

/** 打包环境 + 存在固定更新配置，才允许检查更新。 */
export function isUpdateSupported(options: {
  isPackaged: boolean;
  hasFeedFile: boolean;
}): boolean {
  return options.isPackaged && options.hasFeedFile;
}

/** 检查更新的硬超时（快速失败，不允许无限转圈）。 */
export const UPDATE_CHECK_TIMEOUT_MS = 6_000;
/** 下载停滞判定：这么久没有任何字节增长就报错。 */
export const UPDATE_STALL_TIMEOUT_MS = 20_000;
/** 留档安装包数量，超出按修改时间淘汰最旧的。 */
export const ARCHIVE_KEEP = 3;

export function archiveFileName(version: string): string {
  return `PiForge-${version}.exe`;
}

export function parseArchiveVersion(name: string): string | null {
  const match = /^PiForge-(\d[^/\\]*)\.exe$/i.exec(name);
  return match ? match[1] : null;
}

/**
 * 从留档目录里挑出要删除的文件名（保留最近 keep 份）。
 * 入参按 mtime 降序传入；非安装包文件一律忽略，绝不误删。
 */
export function selectArchivesToDelete(
  entries: Array<{ name: string; mtimeMs: number }>,
  keep = ARCHIVE_KEEP,
): string[] {
  const archives = entries
    .filter((entry) => parseArchiveVersion(entry.name) !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return archives.slice(Math.max(0, keep)).map((entry) => entry.name);
}

/** 人类可读体积，UI 与日志共用。 */
export function formatBytes(bytes: number): string {
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
