/**
 * Agent Host 就绪状态机（纯函数 + 常量，不碰 Electron）。
 *
 * 背景（0.9.0 冷启动实测 24.4s vs PAD 3.7s）：旧实现在 10s 内没等到
 * `host_ready` 就 `child.kill()`，退出码 0 被当异常 → 走重启退避 → 又白等
 * 一轮，日志里连着两条 `Agent Host failed to become ready {timeoutMs:10000}`。
 *
 * 新语义分两级：
 *   - **软超时 20s**：只把状态标成 `degraded` 并通知渲染进程（UI 显示"引擎启动
 *     中"），**不杀进程** —— 慢机器上 Host 往往在 20–40s 之间自己就绪；
 *   - **硬超时 60s**（从启动算）：仍然没有 `host_ready` 才认定挂死，杀掉交给
 *     restart-policy 处理。
 *
 * 状态机本身与计时器解耦：main.ts 负责 setTimeout，这里只回答"该做什么"。
 */

export const AGENT_HOST_READY_TIMEOUT_MS = 20_000;
export const AGENT_HOST_HARD_TIMEOUT_MS = 60_000;

export type AgentHostState = "off" | "booting" | "ready" | "degraded";

export type HostTimeoutAction =
  /** 只报告 + 通知 UI，进程继续跑。 */
  | "report"
  /** 认定挂死：杀掉进程，交给重启策略。 */
  | "kill"
  /** 已经就绪或已退出，超时计时器不该再产生动作。 */
  | "ignore";

export interface HostReadinessSnapshot {
  state: AgentHostState;
  /** 是否已经收到过 host_ready。 */
  ready: boolean;
  /** 软超时是否已经报过（避免刷屏）。 */
  reportedSoftTimeout: boolean;
}

export function initialHostReadiness(): HostReadinessSnapshot {
  return { state: "off", ready: false, reportedSoftTimeout: false };
}

export function markHostBooting(): HostReadinessSnapshot {
  // 重启时保留 `reportedSoftTimeout` 会漏掉新进程的 soft 报告，这里显式重置。
  return { state: "booting", ready: false, reportedSoftTimeout: false };
}

export function markHostReady(): HostReadinessSnapshot {
  return { state: "ready", ready: true, reportedSoftTimeout: false };
}

export function markHostStopped(): HostReadinessSnapshot {
  return { state: "off", ready: false, reportedSoftTimeout: false };
}

/** 软超时到点：就绪过就忽略；否则只报告一次。 */
export function onSoftTimeout(snapshot: HostReadinessSnapshot): {
  snapshot: HostReadinessSnapshot;
  action: HostTimeoutAction;
} {
  if (snapshot.ready || snapshot.state === "off") {
    return { snapshot, action: "ignore" };
  }
  if (snapshot.reportedSoftTimeout) {
    return { snapshot, action: "report" };
  }
  return {
    snapshot: { ...snapshot, state: "degraded", reportedSoftTimeout: true },
    action: "report",
  };
}

/** 硬超时到点：就绪/已退出忽略，否则杀掉。 */
export function onHardTimeout(snapshot: HostReadinessSnapshot): {
  snapshot: HostReadinessSnapshot;
  action: HostTimeoutAction;
} {
  if (snapshot.ready || snapshot.state === "off") {
    return { snapshot, action: "ignore" };
  }
  return { snapshot, action: "kill" };
}

/**
 * UI 文案：`degraded` 说明引擎还在启动（不是错误），`off` 才是真的没有引擎。
 * 渲染进程按这个映射决定是"启动中…"还是"引擎离线"。
 */
export function describeHostState(state: AgentHostState): {
  label: string;
  blocking: boolean;
} {
  switch (state) {
    case "ready":
      return { label: "后台引擎正常", blocking: false };
    case "booting":
    case "degraded":
      return { label: "后台引擎启动中…", blocking: false };
    default:
      return { label: "后台引擎不可用", blocking: true };
  }
}
