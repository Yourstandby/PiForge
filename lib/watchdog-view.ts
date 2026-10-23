/**
 * 看门狗视图层纯函数（无 React、无 IO）。
 *
 * 只做「把 Host 的只读快照翻译成界面文案 / 等级」，不参与判定。
 * 判定永远在 Host（`agent-host/watchdog.ts`），UI 拿到什么就显示什么 ——
 * 这样界面刷新节奏（1s）不会影响看门狗的扫描节奏与阈值。
 */
import type {
  StatusNotice,
  WatchdogSnapshot,
  WatchdogTaskView,
} from "../contract/domains/watchdog";

export type StallLevel = "none" | "warn" | "stalled";

export interface StallView {
  level: StallLevel;
  /** 派生秒数（本地时钟算的，避免整秒跳变导致抖动）。 */
  idleSeconds: number;
  status: WatchdogTaskView["status"];
  lastSuccessAction: string | null;
  /** 疑似阻塞点（Host 推导，UI 原样显示）。 */
  blocker: string;
  pendingTool: string | null;
}

/** 与 Host 默认阈值一致（20s）；关闭/自定义时以快照里的 config 为准。 */
export const DEFAULT_STALL_MS = 20_000;

const ACTIVE_STATUSES = new Set<WatchdogTaskView["status"]>(["running", "stalled"]);

/** 取某个会话「最值得展示」的任务：优先活跃的，其次最新开始的。 */
export function pickSessionTask(
  tasks: readonly WatchdogTaskView[] | undefined,
  sessionId: string | null | undefined,
): WatchdogTaskView | null {
  if (!tasks || !sessionId) return null;
  let best: WatchdogTaskView | null = null;
  for (const task of tasks) {
    if (task.sessionId !== sessionId) continue;
    if (!best) {
      best = task;
      continue;
    }
    const bestActive = ACTIVE_STATUSES.has(best.status);
    const active = ACTIVE_STATUSES.has(task.status);
    if (active && !bestActive) best = task;
    else if (active === bestActive && task.startedAt >= best.startedAt) best = task;
  }
  return best;
}

/** 某个会话最近一条通知（可选按任务过滤）。 */
export function latestNoticeForSession(
  notices: readonly StatusNotice[] | undefined,
  sessionId: string | null | undefined,
  taskId?: string | null,
): StatusNotice | null {
  if (!notices || !sessionId) return null;
  for (let index = notices.length - 1; index >= 0; index -= 1) {
    const notice = notices[index];
    if (notice.session_id !== sessionId) continue;
    if (taskId && notice.task_id !== taskId) continue;
    return notice;
  }
  return null;
}

/**
 * 工具行 / 心跳区的卡顿等级。
 *
 * - `warn`   ：仍在跑但已超过 stallMs 没有有效进展（黄字 + ⚠️）
 * - `stalled`：看门狗已把任务标成 stalled（整行微红 + 红灯 + 诊断）
 *
 * 只对「正在执行」的行生效：已经结束的工具行不该因为任务停滞而变红。
 */
export function describeStall(
  task: WatchdogTaskView | null,
  options: {
    streaming: boolean;
    now: number;
    stallMs?: number;
  },
): StallView | null {
  if (!task) return null;
  const stallMs = options.stallMs ?? DEFAULT_STALL_MS;
  const idleMs = Math.max(0, options.now - task.lastActivityAt);
  const idleSeconds = Math.round(idleMs / 1000);
  const stalled = task.status === "stalled" || task.status === "failed";
  if (options.streaming) {
    if (stalled) {
      return {
        level: "stalled",
        idleSeconds: Math.max(idleSeconds, task.idleSeconds),
        status: task.status,
        lastSuccessAction: task.lastSuccessAction,
        blocker: task.suspectedBlocker,
        pendingTool: task.pendingTool,
      };
    }
    if (idleMs > stallMs) {
      return {
        level: "warn",
        idleSeconds,
        status: task.status,
        lastSuccessAction: task.lastSuccessAction,
        blocker: task.suspectedBlocker,
        pendingTool: task.pendingTool,
      };
    }
    return null;
  }
  if (stalled) {
    return {
      level: "stalled",
      idleSeconds: Math.max(idleSeconds, task.idleSeconds),
      status: task.status,
      lastSuccessAction: task.lastSuccessAction,
      blocker: task.suspectedBlocker,
      pendingTool: task.pendingTool,
    };
  }
  return null;
}

/** "最后活动: 2秒前" 里的相对时间（0 秒也给人话，不显示 "-1秒前"）。 */
export function formatIdleSeconds(seconds: number): string {
  const value = Math.max(0, Math.round(seconds));
  if (value < 1) return "刚刚";
  if (value < 60) return `${value} 秒前`;
  const minutes = Math.floor(value / 60);
  if (minutes < 60) return `${minutes} 分 ${value % 60} 秒前`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分前`;
}

/** 左侧会话列表的状态灯：只有活跃任务才给灯，避免满屏圆点。 */
export function sessionStatusDot(
  task: WatchdogTaskView | null,
): { tone: "running" | "stalled" | "failed"; label: string; tooltip: string } | null {
  if (!task) return null;
  if (task.status === "stalled") {
    return {
      tone: "stalled",
      label: `已 ${task.idleSeconds} 秒无有效进展`,
      tooltip: `系统检测到该任务已停滞 ${task.idleSeconds} 秒`,
    };
  }
  if (task.status === "failed") {
    return {
      tone: "failed",
      label: "看门狗已标记失败（仅界面标记）",
      tooltip: `系统检测到该任务已失败（停滞 ${task.idleSeconds} 秒）`,
    };
  }
  if (task.status === "running") {
    return {
      tone: "running",
      label: `执行中 · 最后活动 ${formatIdleSeconds(task.idleSeconds)}`,
      tooltip: `执行中 · 最后活动 ${formatIdleSeconds(task.idleSeconds)}`,
    };
  }
  return null;
}

/** 快照里的阈值（关闭时为兜底默认值）。 */
export function stallMsOf(snapshot: WatchdogSnapshot | null | undefined): number {
  const value = snapshot?.config?.stallMs;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : DEFAULT_STALL_MS;
}

/** 并发工具的一行文案：「6 个工具执行中」/「bash 执行中」。 */
export function toolSummary(task: WatchdogTaskView | null | undefined): string | null {
  if (!task) return null;
  const count = task.activeToolCount ?? 0;
  if (count <= 0) return null;
  return `${count} 个工具执行中`;
}

/** 心跳条上的活动秒数：优先用「活的迹象」，避免并发启动后被误读成 0 秒前。 */
export function livenessSeconds(task: WatchdogTaskView | null | undefined, now: number): number {
  if (!task) return 0;
  const base = task.lastLivenessAt ?? task.lastActivityAt;
  return Math.max(0, Math.round((now - base) / 1000));
}

export type PanelLightTone = "idle" | "running" | "stalled" | "failed";

/**
 * 右侧监控面板顶部那颗灯。
 *
 * 介入成功后 Host 会把任务重置回 running，快照一刷新这里自然变绿（红灯 → 绿灯），
 * UI 不需要额外的「介入成功」状态位。
 */
export function panelLight(
  sessionId: string | null | undefined,
  task: WatchdogTaskView | null,
): { tone: PanelLightTone; label: string } {
  if (!sessionId) return { tone: "idle", label: "未选择会话" };
  if (!task) return { tone: "idle", label: "本会话暂无任务" };
  if (task.status === "failed") return { tone: "failed", label: "已标记失败" };
  if (task.status === "stalled") return { tone: "stalled", label: "无有效进展" };
  if (task.status === "completed") return { tone: "idle", label: "任务已结束" };
  return { tone: "running", label: "系统运行正常" };
}
