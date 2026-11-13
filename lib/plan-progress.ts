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
export function planFromMessages(messages: readonly unknown[]): PlanProgress | null {
  let progress: PlanProgress | null = null;
  for (const message of messages as readonly AgentMessage[]) {
    if (!message || message.role !== "assistant") continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || block.type !== "toolCall") continue;
      const call = block as { toolName?: unknown; input?: unknown };
      if (call.toolName !== PLAN_TOOL_NAME) continue;
      progress = applyPlanCall(progress, call.input);
    }
  }
  return progress;
}
