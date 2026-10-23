/**
 * 无进展看门狗 + 状态通知的线协议。
 *
 * 设计边界（硬约束，改动前先读）：
 *   - 这里的所有数据都是**纯程序层观测结果**：定时器 + 计数器，不含任何模型调用；
 *   - 只通过 `watchdog.status`（只读）回给 Renderer，绝不写进 system prompt /
 *     对话历史 / 会话 JSONL，因此不会改变模型的任何一次推理输入；
 *   - 关闭开关（`PIFORGE_WATCHDOG=0`）后 Host 不建定时器、不记状态，
 *     `watchdog.status` 只回 `{ enabled: false }`。
 */

/** 一个任务的宏观状态。`completed` 只用于收尾展示，不再参与扫描。 */
export type WatchdogTaskStatus = "running" | "stalled" | "failed" | "completed";

/** 一个仍在执行的工具（并发工具各自一条）。 */
export interface WatchdogToolView {
  toolCallId: string;
  name: string;
  /** 本工具开始执行的时刻（epoch ms）。 */
  startedAt: number;
  /** 已执行秒数。 */
  runningSeconds: number;
  /** 距上一次输出增量的秒数（没有输出就是距开始）。 */
  idleSeconds: number;
  /** 是否已经有流式输出（无输出不代表失败，只代表它在默默执行）。 */
  hasOutput: boolean;
  /** 是否已超过看门狗的 stallMs 阈值。 */
  overThreshold: boolean;
}

/** `get_task_status(task_id)` 的返回体（含派生字段，便于 UI 直接渲染）。 */
export interface WatchdogTaskView {
  taskId: string;
  sessionId: string;
  cwd?: string;
  status: WatchdogTaskStatus;
  /** 任务（一轮 agent run）开始时刻，Unix epoch ms。 */
  startedAt: number;
  /** 最后一次**有效进展**时刻（成功动作 / 正文增量）。 */
  lastActivityAt: number;
  /** 最后一次**尝试**时刻（含失败与重复调用，仅供参考，不参与判据）。 */
  lastAttemptAt: number;
  /**
   * 最后一次「活的迹象」：有效进展、工具启动 / 流式输出都算。
   * 心跳条用它展示「最后活动: N 秒前」，避免 6 个工具并发时显示成 0 秒前 或 永远不变。
   */
  lastLivenessAt: number;
  /** 派生：now - lastActivityAt，四舍五入到秒。 */
  idleSeconds: number;
  /** 正在执行的工具数（并发）。 */
  activeToolCount: number;
  /** 正在执行的工具里最长无输出的秒数（无工具时为 0）。 */
  toolIdleSeconds: number;
  /** 正在执行的工具列表（最多 8 条，按开始时间）。 */
  tools: WatchdogToolView[];
  /** 有效步骤数（成功且不重复的动作）。 */
  completedSteps: number;
  attempts: number;
  failedAttempts: number;
  duplicateAttempts: number;
  lastSuccessAction: string | null;
  lastError: string | null;
  /** 人类可读的「疑似阻塞点」，由 Host 侧纯函数推导。 */
  suspectedBlocker: string;
  /** 仍在执行中的工具名（没有则为 null）。 */
  pendingTool: string | null;
  /** 已发出的通知条数（含首次 + 退避重复）。 */
  noticeCount: number;
  /** 人工介入次数（看门狗重置也会 +1）。 */
  interventionCount: number;
  /** 上一次介入时刻（epoch ms）。 */
  lastInterventionAt: number | null;
}

/**
 * 介入动作：
 *   - `skip`        强制跳过当前卡住的工具
 *   - `ask_brief`   极简询问（默认）：禁止模型核实，只回一句话，几乎零 Token
 *   - `ask`         深度诊断：允许多工具去查状态，消耗较多 Token
 */
export type InterventionActionType = "skip" | "ask" | "ask_brief";

export type InterventionRejectionReason = "no_active_task" | "duplicate" | "too_many";

/** `agent.intervene` 的返回体。 */
export interface InterventionResult {
  ok: boolean;
  actionType: InterventionActionType;
  /** 实际走的那条投递通路。 */
  delivered: "steer" | "prompt" | "queue";
  /** 注入的原文（便于 UI 显示日志与排查）。 */
  message: string;
  /** 介入后的任务状态（已被重置回 running）。 */
  task: WatchdogTaskView | null;
  /** 被拒绝时的原因；`ok: false` 时必有。 */
  rejected?: InterventionRejectionReason;
  /** 面向用户的一句话（拒绝原因 / 成功回显）。 */
  detail?: string;
}

export type StatusNoticeKind = "stalled" | "recovered" | "failed";

/**
 * 结构化异步通知。
 *
 * 注意「投递」的真实含义：写进 Host 内的低优先级通知队列（只读暴露给 UI），
 * **不进** Agent 的消息队列，因此主 Agent 下一次推理不会消费到它。
 */
export interface StatusNotice {
  type: StatusNoticeKind;
  task_id: string;
  session_id: string;
  cwd?: string;
  /** 最后一次有效进展时间戳（epoch ms）。 */
  last_activity_ts: number;
  idle_seconds: number;
  completed_steps: number;
  last_success_action: string | null;
  suspected_blocker: string;
  /** 固定为 low：UI 侧按「系统事件」低优先级渲染。 */
  level: "low";
  /** 单调递增序号，UI 用来去重 / 判断「有新通知」。 */
  seq: number;
  created_at: number;
  /** 第几次通知：0 = 首次 stalled，1..n = 退避重复。 */
  repeat: number;
  /** 面向用户的一句话。 */
  message: string;
}

/** `watchdog.configure` 的参数：运行期只开放「停滞阈值」一项。 */
export interface WatchdogConfigureInput {
  /** 多久无有效进展算卡顿（毫秒）。Host 侧钳制在 5s ~ 10min。 */
  stallMs: number;
}

export interface WatchdogConfigView {
  tickMs: number;
  stallMs: number;
  /** 连续多少次扫描无进展才判 stalled。 */
  stallScans: number;
  /** 退避重复通知间隔（毫秒）。 */
  backoffMs: number[];
}

/** `watchdog.status` 的返回体：一次拿全，UI 按 sessionId 过滤。 */
export interface WatchdogSnapshot {
  enabled: boolean;
  config: WatchdogConfigView | null;
  tasks: WatchdogTaskView[];
  notices: StatusNotice[];
}
