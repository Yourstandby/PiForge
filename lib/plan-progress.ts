/**
 * 计划进度：把 `plan` 工具调用折叠成一份可直接渲染的步骤状态。
 *
 * 纯函数、无 React、无 I/O：输入是会话消息数组，输出是「几步、做完几步、当前第几步」。
 * 只有输入框上方那张卡片读它，历史消息里的 plan 调用不重复渲染。
 */
import type { AgentMessage } from "./types.ts";

export const PLAN_TOOL_NAME = "plan";
/** 步骤上限：再多就不是清单而是日志了，前端也不该铺满屏。 */
export const PLAN_MAX_STEPS = 20;
export const PLAN_MAX_TITLE = 40;

export type PlanStepStatus = "pending" | "active" | "done";

export interface PlanStep {
  title: string;
  status: PlanStepStatus;
}

export interface PlanProgress {
  steps: PlanStep[];
  done: number;
  total: number;
  /** 进行中的那一步；没有 active 时回落到第一个 pending，全做完是 -1。 */
  activeIndex: number;
}

export function isPlanStepStatus(value: unknown): value is PlanStepStatus {
  return value === "pending" || value === "active" || value === "done";
}

function normalizeTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const title = value.trim().replace(/\s+/g, " ");
  if (!title) return null;
  return title.length > PLAN_MAX_TITLE ? `${title.slice(0, PLAN_MAX_TITLE - 1)}…` : title;
}

function summarize(steps: PlanStep[]): PlanProgress {
  const done = steps.reduce((n, step) => (step.status === "done" ? n + 1 : n), 0);
  const active = steps.findIndex((step) => step.status === "active");
  const pending = steps.findIndex((step) => step.status === "pending");
  return {
    steps,
    done,
    total: steps.length,
    activeIndex: active >= 0 ? active : pending,
  };
}

/**
 * 校验并清洗 `steps` 参数。整份列表非法时返回 null（调用被忽略，进度保持不变）。
 */
export function readPlanSteps(raw: unknown): PlanStep[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const steps: PlanStep[] = [];
  for (const item of raw.slice(0, PLAN_MAX_STEPS)) {
    const title = normalizeTitle(
      typeof item === "string"
        ? item
        : item && typeof item === "object"
          ? (item as Record<string, unknown>).title
          : null,
    );
    if (!title) continue;
    const rawStatus =
      item && typeof item === "object"
        ? (item as Record<string, unknown>).status
        : undefined;
    steps.push({ title, status: isPlanStepStatus(rawStatus) ? rawStatus : "pending" });
  }
  return steps.length > 0 ? steps : null;
}

/** 校验 `update`（增量推进）。 */
export function readPlanUpdate(raw: unknown): { index: number; status: PlanStepStatus } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.index !== "number" || !Number.isInteger(obj.index) || obj.index < 0) return null;
  if (!isPlanStepStatus(obj.status)) return null;
  return { index: obj.index, status: obj.status };
}

/**
 * 应用一次 plan 工具调用：先看全量 steps，再看增量 update。
 * 幂等 —— 同一份输入重复应用，结果不变。
 */
export function applyPlanCall(current: PlanProgress | null, input: unknown): PlanProgress | null {
  const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  let next = current;
  const steps = readPlanSteps(args.steps);
  if (steps) next = summarize(steps);
  const update = readPlanUpdate(args.update);
  if (update && next && update.index < next.steps.length) {
    next = summarize(
      next.steps.map((step, i) => (i === update.index ? { ...step, status: update.status } : step)),
    );
  }
  return next;
}

/**
 * 从会话消息里取最后一次 plan 工具调用后的完整状态。
 * 没有调用过 → null（卡片不渲染）。
 */
export interface PlanFromMessagesOptions {
  /**
   * 只折叠**最后一条用户消息之后**的 plan 调用。
   * 卡片贴在输入框上方，语义是"这一轮在干什么"；不限范围的话，上一轮没结尾的
   * 计划会被一直翻出来（切会话、重启、开新轮次都还在）。
   */
  sinceLastUser?: boolean;
  /** 起始消息下标（含），缺省 0（或 sinceLastUser 的边界，两者取大）。 */
  from?: number;
  /** 结束消息下标（不含），缺省到数组末尾。 */
  to?: number;
}

/** 最后一条用户消息的下标 + 1；没有用户消息时返回 0（等价全量折叠）。 */
function lastUserBoundary(messages: readonly AgentMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return index + 1;
  }
  return 0;
}

export function planFromMessages(
  messages: readonly unknown[],
  options: PlanFromMessagesOptions = {},
): PlanProgress | null {
  let progress: PlanProgress | null = null;
  const all = messages as readonly AgentMessage[];
  const sinceStart = options.sinceLastUser ? lastUserBoundary(all) : 0;
  const start = Math.max(sinceStart, options.from ?? 0);
  const end = Math.max(start, Math.min(all.length, options.to ?? all.length));
  for (let index = start; index < end; index += 1) {
    const message = all[index];
    if (!message) continue;
    // codemode 脚本内的 plan 调用不是顶层 toolCall（SDK 不会把嵌套调用写进消息），
    // 只记录在结果的 nestedCalls 上。不扫这里 → 只要模型把 plan 塞进脚本，
    // 卡片就永远不渲染，而"合并进一次脚本"恰恰是被鼓励的路径。
    if (message.role === "toolResult") {
      const calls = (message as { nestedCalls?: { calls?: unknown } }).nestedCalls?.calls;
      if (Array.isArray(calls)) {
        for (const record of calls) {
          const nested = record as { name?: unknown; arguments?: unknown };
          if (nested?.name !== PLAN_TOOL_NAME) continue;
          progress = applyPlanCall(progress, nested.arguments);
        }
      }
      continue;
    }
    if (message.role !== "assistant") continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || block.type !== "toolCall") continue;
      // 两种形状都要认：SDK/会话 JSONL 里是 {id, name, arguments}，
      // 而 AgentMessage 的 TS 定义是 {toolCallId, toolName, input}。
      // 只认后者 → 真实会话里一次都匹配不上，卡片永远不渲染。
      const call = block as {
        toolName?: unknown;
        name?: unknown;
        input?: unknown;
        arguments?: unknown;
      };
      const toolName = call.toolName ?? call.name;
      if (toolName !== PLAN_TOOL_NAME) continue;
      progress = applyPlanCall(progress, call.input ?? call.arguments);
    }
  }
  return progress;
}

/**
 * 折叠**某一段消息区间**里的 plan 调用：给「一轮对话」冻结一张卡片用。
 *
 * 和输入框上方那张（sinceLastUser 口径）的区别：这里按区间切，
 * 一轮结束时的进度就是这一轮最终的样子，不会因为下一轮开了新计划而被改写，
 * 于是卡片能钉死在该轮末尾，不跟着新任务往下走。
 */
export function planInRange(
  messages: readonly unknown[],
  from: number,
  toExclusive: number,
): PlanProgress | null {
  return planFromMessages(messages, { from, to: toExclusive });
}

/** planByRound 只需要轮次的两个字段，不绑定 Transcript 的视图类型。 */
export interface RoundBoundary {
  role: "user" | "assistant";
  /** 该轮次对应的消息下标。 */
  messageIndex: number;
}

/**
 * 每一轮对话冻结下来的计划卡片，按**该轮最后一条渲染轮次的下标**索引。
 *
 * 为什么不取全局最新（planFromMessages）：卡片要钉在上一轮的末尾 ——
 * 新任务开跑后不能跟着往下走，也不能被下一轮的 plan 调用改写。
 * 区间 = [该轮 user 消息下标, 下一条 user 消息下标)。
 *
 * 返回的 lastRoundStart 是最后一轮 user 轮次的下标：调用方用它决定
 * 「这一轮的计划还在输入框上方那张活卡片里，别在转录里重复渲染」。
 */
export function planByRound(
  turns: readonly RoundBoundary[],
  messages: readonly unknown[],
): { plans: Map<number, PlanProgress>; lastRoundStart: number } {
  const plans = new Map<number, PlanProgress>();
  let roundStart = -1;
  let roundEndTurn = -1;
  let lastRoundStart = 0;
  const close = (endMessageIndex: number) => {
    if (roundStart < 0) return;
    const progress = planInRange(messages, roundStart, endMessageIndex);
    if (progress) plans.set(roundEndTurn, progress);
  };
  turns.forEach((turn, index) => {
    if (turn.role === "user") {
      close(turn.messageIndex);
      lastRoundStart = index;
      roundStart = turn.messageIndex;
      roundEndTurn = index;
      return;
    }
    if (roundStart >= 0) roundEndTurn = index;
  });
  close(messages.length);
  return { plans, lastRoundStart };
}
