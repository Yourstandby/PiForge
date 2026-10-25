/**
 * ProgressTracker：任务级「有效进展」心跳记录器（纯程序层，无模型调用）。
 *
 * 判据刻意分两层，因为「没进展」和「没动作」不是一回事：
 *   - `lastAttemptAt`  ：任何事件到达都刷（含失败 / 重复调用 / 空返回）；
 *   - `lastActivityAt` ：**只有有效进展**才刷 —— 成功且不重复的工具调用、
 *                        正文/思考文本的增量输出。
 * 看门狗只看后者，所以「反复跑同一条报错命令」不会被误判成有进展。
 *
 * 本文件不启动任何定时器，也不接触 pi 的消息队列；纯函数式状态机，方便单测。
 */
import type { WatchdogTaskStatus } from "../contract/domains/watchdog.ts";

/** 判定「重复调用」时保留多少次成功签名（够覆盖典型的原地打转）。 */
const SUCCESS_SIGNATURE_MEMORY = 24;
/** 错误摘要上限：太长会撑爆 UI tooltip。 */
const MAX_ERROR_CHARS = 240;
/** 同时保留多少个任务（历史任务只用于收尾展示）。 */
const MAX_TRACKED_TASKS = 32;
/** 单个任务里同时跟踪多少个工具（并发 6 个很常见，给足余量）。 */
export const MAX_TRACKED_TOOLS = 16;

/**
 * 每个工具名最近若干次的实际耗时（毫秒）。
 *
 * 用途只有一个：给「卡了多久算久」找一个**相对**基线。绝对阈值回答不了
 * 「要不要介入」——tsc 跑 90 秒是正常，等模型首 token 30 秒就该管。
 * 全程只读历史、不写会话、不触发任何模型调用。
 */
const TOOL_DURATION_SAMPLES = 20;
const toolDurationSamples = new Map<string, number[]>();

/** 记录一次已结束工具的实际耗时（供基线统计，不参与任何状态写回）。 */
export function recordToolDuration(name: string, ms: number): void {
  if (!name || !Number.isFinite(ms) || ms <= 0) return;
  const samples = toolDurationSamples.get(name) ?? [];
  samples.push(Math.round(ms));
  if (samples.length > TOOL_DURATION_SAMPLES) samples.shift();
  toolDurationSamples.set(name, samples);
}

/** 某工具的历史耗时中位数；样本不足 3 个时返回 null（不拿噪声当基线）。 */
export function toolDurationBaseline(name: string): { medianMs: number; samples: number } | null {
  const samples = toolDurationSamples.get(name);
  if (!samples || samples.length < 3) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const medianMs =
    sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  return { medianMs, samples: samples.length };
}

/** 测试用：清空基线样本。 */
export function resetToolDurationBaselinesForTest(): void {
  toolDurationSamples.clear();
}

/**
 * 一个仍在跑的工具。
 *
 * 为什么必须逐个跟踪：「6 个 bash 并发跑 62 秒且都没输出」在任务层面看起来
 * 只是「没有新事件」，但在工具层面是 6 个都很久没动静 —— 必须能看见每一个，
 * 才能在任意一个超时时立刻判 stalled，面板也才能显示「6 个工具执行中」。
 */
export interface RunningTool {
  toolCallId: string;
  name: string;
  startedAt: number;
  /** 最后一次输出增量时刻（无输出则等于 startedAt）。 */
  lastOutputAt: number;
  hasOutput: boolean;
}

export interface TaskProgress {
  taskId: string;
  sessionId: string;
  cwd?: string;
  status: WatchdogTaskStatus;
  startedAt: number;
  lastActivityAt: number;
  lastAttemptAt: number;
  /** 最后一个「活的迹象」（进展 / 工具启动 / 工具输出）：心跳展示用。 */
  lastLivenessAt: number;
  lastSuccessAction: string | null;
  lastError: string | null;
  completedSteps: number;
  attempts: number;
  failedAttempts: number;
  duplicateAttempts: number;
  /** 连续失败次数（成功即清零），用来推导「疑似阻塞点」。 */
  consecutiveFailures: number;
  lastFailedTool: string | null;
  pendingTool: string | null;
  pendingSince: number | null;
  /** 正在执行的全部工具（并发时每个一条）。 */
  runningTools: RunningTool[];
  /** 已观测到的正文+思考字符数，用于识别「文本还在长」。 */
  textChars: number;
  /** 看门狗内部状态：连续无进展扫描次数。 */
  staleScans: number;
  /** 已发出的退避重复次数。 */
  repeats: number;
  /** 下一次该发退避通知的时刻（null = 还没进 stalled / 已发完）。 */
  nextNoticeAt: number | null;
  noticeCount: number;
  /** 人工介入次数与最近一次介入信息（防重复触发 / UI 展示）。 */
  interventions: number;
  lastInterventionAt: number | null;
  lastInterventionAction: "skip" | "ask" | "ask_brief" | null;
  /** 已成功过的工具签名，用于识别重复调用。 */
  successSignatures: string[];
}

let taskCounter = 0;

function emptyTask(sessionId: string, now: number, cwd?: string): TaskProgress {
  taskCounter += 1;
  return {
    taskId: `${sessionId}~${taskCounter}`,
    sessionId,
    ...(cwd ? { cwd } : {}),
    status: "running",
    startedAt: now,
    lastActivityAt: now,
    lastAttemptAt: now,
    lastLivenessAt: now,
    lastSuccessAction: null,
    lastError: null,
    completedSteps: 0,
    attempts: 0,
    failedAttempts: 0,
    duplicateAttempts: 0,
    consecutiveFailures: 0,
    lastFailedTool: null,
    pendingTool: null,
    pendingSince: null,
    runningTools: [],
    textChars: 0,
    staleScans: 0,
    repeats: 0,
    nextNoticeAt: null,
    noticeCount: 0,
    interventions: 0,
    lastInterventionAt: null,
    lastInterventionAction: null,
    successSignatures: [],
  };
}

function truncate(text: string, max = MAX_ERROR_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 稳定序列化：只用于「同一次调用是否重复」的比较，键顺序先归一。 */
function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (input: unknown): unknown => {
    if (input === null || typeof input !== "object") {
      return typeof input === "string" ? input : input;
    }
    if (seen.has(input as object)) return "[circular]";
    seen.add(input as object);
    if (Array.isArray(input)) return input.map(walk);
    const entries = Object.entries(input as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const out: Record<string, unknown> = {};
    for (const [key, entry] of entries) out[key] = walk(entry);
    return out;
  };
  try {
    return JSON.stringify(walk(value));
  } catch {
    return "[unserializable]";
  }
}

/** 正文 + 思考的字符数：文本还在变长就说明模型仍在产出。 */
export function assistantTextLength(message: unknown): number {
  if (!message || typeof message !== "object") return 0;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";
    if (type === "text" && typeof record.text === "string") total += record.text.length;
    else if (type === "thinking" && typeof record.thinking === "string") {
      total += record.thinking.length;
    }
  }
  return total;
}

function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const record = block as Record<string, unknown>;
      return typeof record.text === "string" ? record.text : "";
    })
    .join(" ");
}

/** 「疑似阻塞点」：纯推导，给 UI 一句人话，不参与任何判定。 */
export function describeSuspectedBlocker(task: TaskProgress, now: number): string {
  const running = task.runningTools;
  if (running.length > 1) {
    const longest = running.reduce((worst, tool) =>
      now - tool.lastOutputAt > now - worst.lastOutputAt ? tool : worst,
    );
    const seconds = Math.max(0, Math.round((now - longest.lastOutputAt) / 1000));
    const others = running.filter((tool) => tool !== longest).map((tool) => tool.name);
    const extra = others.length > 0 ? `（另有 ${others.slice(0, 4).join("、")}）` : "";
    return `${running.length} 个工具并发执行中，最久的 ${longest.name} 已 ${seconds}s 无输出${extra}`;
  }
  if (running.length === 1) {
    const tool = running[0]!;
    const seconds = Math.max(0, Math.round((now - tool.lastOutputAt) / 1000));
    return `工具 ${tool.name} 已执行 ${seconds}s ${
      tool.hasOutput ? "仍无新的输出增量" : "仍无输出增量"
    }（可能卡在子进程 / 网络等待）`;
  }
  if (task.pendingTool) {
    const seconds = task.pendingSince ? Math.max(0, Math.round((now - task.pendingSince) / 1000)) : 0;
    return `工具 ${task.pendingTool} 已执行 ${seconds}s 仍无输出增量（可能卡在子进程 / 网络等待）`;
  }
  if (task.consecutiveFailures >= 2 && task.lastFailedTool) {
    const detail = task.lastError ? `，最近错误：${truncate(task.lastError, 120)}` : "";
    return `${task.lastFailedTool} 连续失败 ${task.consecutiveFailures} 次${detail}`;
  }
  if (task.failedAttempts > 0 && task.lastFailedTool) {
    const detail = task.lastError ? `（${truncate(task.lastError, 120)}）` : "";
    return `${task.lastFailedTool} 调用失败${detail}，模型可能正在原地重试`;
  }
  if (task.completedSteps === 0) {
    return "本任务尚无任何成功动作，可能在等待上游模型响应";
  }
  return "最近无新事件（模型或工具可能已停滞，也可能在等待上游）";
}

export interface ProgressEvent {
  type: string;
  toolCallId?: unknown;
  toolName?: unknown;
  args?: unknown;
  result?: unknown;
  isError?: unknown;
  message?: unknown;
  [key: string]: unknown;
}

export class ProgressTracker {
  private readonly tasks = new Map<string, TaskProgress>();
  private readonly current = new Map<string, string>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** 当前（或最近一个）任务。 */
  taskOf(sessionId: string): TaskProgress | undefined {
    const id = this.current.get(sessionId);
    if (!id) return undefined;
    return this.tasks.get(id);
  }

  /** 正在执行的工具里最久无输出的秒数（无工具时为 0）。 */
  static toolIdleSeconds(task: TaskProgress, now: number): number {
    let worst = 0;
    for (const tool of task.runningTools) {
      worst = Math.max(worst, now - tool.lastOutputAt);
    }
    return worst > 0 ? Math.round(worst / 1000) : 0;
  }

  /** 是否有任一并发工具已超过阈值 —— 只要有一个卡住，整任务就该报 stalled。 */
  static hasBlockedTool(task: TaskProgress, now: number, stallMs: number): boolean {
    return task.runningTools.some((tool) => now - tool.lastOutputAt > stallMs);
  }

  /** 所有仍在跑（running / stalled）的任务：看门狗只扫这些。 */
  activeTasks(): TaskProgress[] {
    const out: TaskProgress[] = [];
    for (const task of this.tasks.values()) {
      if (task.status === "running" || task.status === "stalled") out.push(task);
    }
    return out;
  }

  allTasks(): TaskProgress[] {
    return [...this.tasks.values()];
  }

  getTask(taskId: string): TaskProgress | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * 开一轮新任务。上一轮若还在跑（用户直接发新消息、上游没发 agent_end），
   * 就地收尾成 completed，避免它继续被判定为 stalled。
   */
  beginTask(sessionId: string, cwd?: string): TaskProgress {
    const previous = this.taskOf(sessionId);
    if (previous && (previous.status === "running" || previous.status === "stalled")) {
      previous.status = "completed";
      previous.nextNoticeAt = null;
    }
    const task = emptyTask(sessionId, this.now(), cwd);
    this.tasks.set(task.taskId, task);
    this.current.set(sessionId, task.taskId);
    this.trim();
    return task;
  }

  endTask(sessionId: string, status: WatchdogTaskStatus = "completed"): TaskProgress | undefined {
    const task = this.taskOf(sessionId);
    if (!task) return undefined;
    task.status = status;
    task.nextNoticeAt = null;
    task.pendingTool = null;
    task.pendingSince = null;
    task.runningTools = [];
    return task;
  }

  forgetSession(sessionId: string): void {
    const task = this.taskOf(sessionId);
    if (task && (task.status === "running" || task.status === "stalled")) task.status = "completed";
    this.current.delete(sessionId);
  }

  /** 单测 / 复位：丢掉全部任务。 */
  clear(): void {
    this.tasks.clear();
    this.current.clear();
  }

  /**
   * 人工介入后的强制重置：状态回到 running、所有停滞计数清零、
   * 活动时间重新计一整个 stallMs 窗口。
   */
  markIntervened(
    sessionId: string,
    action: "skip" | "ask" | "ask_brief",
    now: number,
  ): TaskProgress | undefined {
    const task = this.taskOf(sessionId);
    if (!task) return undefined;
    task.status = "running";
    task.lastActivityAt = now;
    task.lastAttemptAt = now;
    task.lastLivenessAt = now;
    task.staleScans = 0;
    task.repeats = 0;
    task.nextNoticeAt = null;
    task.interventions += 1;
    task.lastInterventionAt = now;
    task.lastInterventionAction = action;
    // 介入后给并发工具重新计一次「无输出」窗口：否则刚从看门狗手里拿回控制权，
    // 下一 tick 又会被同一个已超阈的工具立刻判回 stalled。
    for (const tool of task.runningTools) tool.lastOutputAt = now;
    return task;
  }

  /**
   * 观测一条 pi 事件。返回值带 `recovered`：调用方（看门狗）据此发一条
   * 「已恢复」通知，UI 才知道该把黄灯摘掉。
   */
  observe(
    sessionId: string,
    event: ProgressEvent,
    cwd?: string,
  ): { task: TaskProgress; recovered: boolean } | null {
    if (!event || typeof event.type !== "string") return null;
    const now = this.now();
    const type = event.type;

    // `agent_end` 与 `agent_settled` 都是收尾信号。wrapper 会把 agent_end 扣到
    // settled 之后才转发给订阅者，所以直接看原始事件，避免「已经跑完的任务
    // 还被当成 running 判成 stalled」。
    if (type === "agent_end" || type === "agent_settled") {
      const ended = this.endTask(sessionId, "completed");
      return ended ? { task: ended, recovered: false } : null;
    }

    let task = this.taskOf(sessionId);
    const starting = type === "agent_start";
    // 首轮任务：agent_start 之前也可能先到 message/tool 事件（重放、断线续传）。
    if (!task || ((task.status === "completed" || task.status === "failed") && starting)) {
      task = this.beginTask(sessionId, cwd);
    }
    if (task.status === "completed" || task.status === "failed") return { task, recovered: false };

    const wasStalled = task.status === "stalled";
    let progressed = false;

    /** 有进展：有效活动 + 心跳都刷。 */
    const markActivity = () => {
      progressed = true;
      task!.lastActivityAt = now;
      task!.lastLivenessAt = now;
      task!.staleScans = 0;
    };

    /** 只是「还活着」（工具刚启动等）：刷心跳，但不算进展。 */
    const touchLiveness = (at: number = now) => {
      task!.lastLivenessAt = Math.max(task!.lastLivenessAt, at);
    };

    switch (type) {
      case "agent_start": {
        markActivity();
        task.attempts += 1;
        break;
      }
      case "message_start":
      case "message_update":
      case "message_end": {
        task.lastAttemptAt = now;
        touchLiveness();
        // 新消息 → 文本长度重新计（否则短的新消息永远追不上旧消息的累计值，
        // 会把「正在输出」误判成「无进展」）。
        if (type === "message_start") task.textChars = 0;
        const chars = assistantTextLength(event.message);
        if (chars > task.textChars) {
          task.textChars = chars;
          markActivity();
        }
        break;
      }
      case "tool_execution_start": {
        task.lastAttemptAt = now;
        task.attempts += 1;
        const toolName = typeof event.toolName === "string" && event.toolName ? event.toolName : "tool";
        const toolCallId =
          typeof event.toolCallId === "string" && event.toolCallId
            ? event.toolCallId
            : `${toolName}-${task.attempts}`;
        // 并发关键点：每个 toolCallId 各占一条，绝不用单个 pendingTool 互相覆盖。
        if (!task.runningTools.some((tool) => tool.toolCallId === toolCallId)) {
          task.runningTools.push({
            toolCallId,
            name: toolName,
            startedAt: now,
            lastOutputAt: now,
            hasOutput: false,
          });
          if (task.runningTools.length > MAX_TRACKED_TOOLS) task.runningTools.shift();
        }
        // 「工具启动了」= 还活着（心跳），但不是「有进展」—— 否则并发长任务
        // 会被误判成一直在推进，卡死也看不出来。
        touchLiveness();
        // 旧的单槽位字段保留给旧的阻塞点文案 / 兼容旧调用方。
        task.pendingTool = toolName;
        task.pendingSince = now;
        break;
      }
      case "tool_execution_update": {
        // 有流式输出 = 这个工具真的在动（这是一次新输出，不是重复调用）。
        task.lastAttemptAt = now;
        const updated = typeof event.toolName === "string" ? event.toolName : null;
        const updatedId = typeof event.toolCallId === "string" ? event.toolCallId : null;
        const target =
          (updatedId ? task.runningTools.find((tool) => tool.toolCallId === updatedId) : undefined) ??
          (updated ? task.runningTools.find((tool) => tool.name === updated) : undefined);
        if (target) {
          target.lastOutputAt = now;
          target.hasOutput = true;
        } else if (updated) {
          // 只见过 update、没见过 start（重连重放丢了 start）：补登一条。
          task.runningTools.push({
            toolCallId: updatedId ?? `${updated}-${task.attempts}`,
            name: updated,
            startedAt: now,
            lastOutputAt: now,
            hasOutput: true,
          });
          if (task.runningTools.length > MAX_TRACKED_TOOLS) task.runningTools.shift();
        }
        if (updated) task.pendingTool = updated;
        markActivity();
        break;
      }
      case "tool_execution_end": {
        task.lastAttemptAt = now;
        touchLiveness();
        const tool = typeof event.toolName === "string" && event.toolName ? event.toolName : "tool";
        const endedId = typeof event.toolCallId === "string" ? event.toolCallId : null;
        // 只移除这一个工具；其他并发工具继续跟踪。
        const index = endedId
          ? task.runningTools.findIndex((entry) => entry.toolCallId === endedId)
          : task.runningTools.findIndex((entry) => entry.name === tool);
        const endedTool = index !== -1 ? task.runningTools[index] : null;
        if (index !== -1) task.runningTools.splice(index, 1);
        if (endedTool) recordToolDuration(endedTool.name, now - endedTool.startedAt);
        const stillRunningSame = task.runningTools.filter((entry) => entry.name === tool);
        if (task.pendingTool === tool) {
          const last = stillRunningSame[stillRunningSame.length - 1];
          task.pendingTool = last ? last.name : null;
          task.pendingSince = last ? last.startedAt : null;
        }
        if (event.isError === true) {
          task.failedAttempts += 1;
          task.consecutiveFailures += 1;
          task.lastFailedTool = tool;
          const text = truncate(resultText(event.result));
          task.lastError = text || `${tool} 返回失败（无输出）`;
          // 失败 / 空返回：只记尝试时间，**不刷有效活动时间**。
          break;
        }
        const text = resultText(event.result).trim();
        if (!text) {
          // 空返回也不算进展（可能是被兜底吞掉的失效工具）。
          task.duplicateAttempts += 1;
          break;
        }
        const signature = `${tool}|${stableStringify(event.args ?? event.result)}`.slice(0, 400);
        if (task.successSignatures.includes(signature)) {
          // 重复调用：只记尝试时间。
          task.duplicateAttempts += 1;
          break;
        }
        task.successSignatures.push(signature);
        if (task.successSignatures.length > SUCCESS_SIGNATURE_MEMORY) {
          task.successSignatures.shift();
        }
        task.completedSteps += 1;
        task.consecutiveFailures = 0;
        task.lastError = null;
        task.lastSuccessAction = tool;
        markActivity();
        break;
      }
      case "turn_start":
      case "turn_end": {
        task.lastAttemptAt = now;
        if (type === "turn_end") task.runningTools = [];
        markActivity();
        break;
      }
      default: {
        // 未知事件：只算「有动作」，不算进展。
        task.lastAttemptAt = now;
        break;
      }
    }

    const recovered = wasStalled && progressed;
    if (recovered) {
      task.status = "running";
      task.staleScans = 0;
      task.repeats = 0;
      task.nextNoticeAt = null;
    }
    return { task, recovered };
  }

  private trim(): void {
    if (this.tasks.size <= MAX_TRACKED_TASKS) return;
    const finished = [...this.tasks.values()]
      .filter((task) => task.status === "completed" || task.status === "failed")
      .sort((a, b) => a.lastActivityAt - b.lastActivityAt);
    while (this.tasks.size > MAX_TRACKED_TASKS && finished.length > 0) {
      const victim = finished.shift();
      if (!victim) break;
      this.tasks.delete(victim.taskId);
    }
  }
}

/** 单测用：让任务 id 可预期。 */
export function resetProgressTrackerIdsForTest(): void {
  taskCounter = 0;
}
