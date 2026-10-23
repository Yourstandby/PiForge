/**
 * 人工介入（Human-in-the-loop）的纯逻辑：文案 + 投递方式 + 重复触发守卫。
 *
 * 边界说明：
 *   - 这里只产出「一段要注入队列的文本」和一个投递决策，本身不发任何东西；
 *     真正的注入由 `AgentSessionWrapper.deliverIntervention()` 走已有的
 *     steer / prompt / follow-up 队列三条通路完成；
 *   - 介入文本是**用户主动点的**，因此允许进入对话历史（区别于看门狗自动通知，
 *     那些只留在界面队列里，永不进 prompt）；
 *   - 没有任何模型直连：不 import SDK、不调 `prompt()`。
 */
import type { WatchdogTaskStatus } from "../contract/domains/watchdog.ts";

/**
 * 介入动作：`skip` = 强制跳过；`ask` 与 `ask_brief` 都是追问，只差提示词强度。
 *
 * `ask_brief` 是默认动作：追问"你为什么卡了"这类问题，模型天然会去跑 `tsc` /
 * `grep` 重新核实状态，一次就能烧掉上万 Token 并且把执行流堵死。所以默认动作
 * 必须在提示词里显式**禁止新增工具调用**并限定输出长度。
 */
export type InterventionAction = "skip" | "ask" | "ask_brief";

/** `params.actionType` 的边界校验（Host 侧不信前端）。 */
export function isInterventionAction(value: unknown): value is InterventionAction {
  return value === "skip" || value === "ask" || value === "ask_brief";
}

/** Skip：最高优先级系统指令，要求模型放弃当前卡住的工具并换方案。 */
export const SKIP_INSTRUCTION =
  "[系统提示] 当前工具执行因无进展被系统强制跳过。请反思刚才为什么卡住，并立刻尝试其他替代方案继续完成任务。";

/** Ask（深度诊断）：普通用户口吻的追问（`last_success_action` 未知时的兜底说法）。 */
export const ASK_FALLBACK_STEP = "上一步";

/**
 * 极简询问：一句话、零工具、零核实。
 *
 * 三个约束缺一不可 ——
 *   1. "请勿执行任何新工具核实"：断掉模型自己跑 `tsc`/`grep` 的念头；
 *   2. "一句话（20字以内）"：把输出长度钉死，避免长篇复盘；
 *   3. 只问两个可回答的问题：卡在哪个工具、要不要跳过。
 */
export const BRIEF_ASK_INSTRUCTION =
  "[系统提示] 看门狗发现当前工具已超时无输出，请勿执行任何新工具核实。请直接用一句话（20字以内）告诉我：你卡在哪个工具了，是否需要我帮你跳过？";

export function buildAskMessage(lastSuccessAction: string | null | undefined): string {
  const step = lastSuccessAction?.trim() || ASK_FALLBACK_STEP;
  return `你之前在 ${step} 之后似乎卡住了，请分析原因并给出新的执行方案。`;
}

export function buildInterventionMessage(
  action: InterventionAction,
  lastSuccessAction: string | null | undefined,
): string {
  if (action === "skip") return SKIP_INSTRUCTION;
  if (action === "ask_brief") return BRIEF_ASK_INSTRUCTION;
  return buildAskMessage(lastSuccessAction);
}

/** 投递通路：正在流式 → steer（最高优先级）；有排队 → 插到队首；否则直接 prompt。 */
export type InterventionDelivery = "steer" | "prompt" | "queue";

export function resolveDelivery(input: {
  streaming: boolean;
  queued: number;
}): InterventionDelivery {
  if (input.streaming) return "steer";
  if (input.queued > 0) return "queue";
  return "prompt";
}

/** 同一个任务内，同一种介入动作的冷却时间（防连点 / 防重放）。 */
export const INTERVENE_COOLDOWN_MS = 3_000;
/** 单个任务最多介入这么多次，防止把队列刷爆。 */
export const MAX_INTERVENTIONS_PER_TASK = 5;

export type InterventionRejection = "no_active_task" | "duplicate" | "too_many";

export interface InterventionGuardInput {
  actionType: InterventionAction;
  taskStatus: WatchdogTaskStatus | null;
  /** 演示/测试可注入当前时间。 */
  now: number;
  lastInterventionAt: number | null;
  lastInterventionAction: InterventionAction | null;
  interventions: number;
}

export interface InterventionGuardResult {
  allowed: boolean;
  reason?: InterventionRejection;
  /** 面向用户的一句话（拒绝时说明原因）。 */
  detail?: string;
}

/**
 * 「这次介入该不该放行」的唯一判据。
 *
 * 为什么必须放在 Host：UI 的按钮状态只是体验层，重连、双击、两个窗口同时点
 * 都会各发一次 RPC；真正防重复的地方必须在看门狗状态里（每个任务一份）。
 */
export function checkIntervention(input: InterventionGuardInput): InterventionGuardResult {
  const active = input.taskStatus === "running" || input.taskStatus === "stalled";
  if (!active) {
    return {
      allowed: false,
      reason: "no_active_task",
      detail: "当前没有正在执行的任务，无需介入。",
    };
  }
  if (input.interventions >= MAX_INTERVENTIONS_PER_TASK) {
    return {
      allowed: false,
      reason: "too_many",
      detail: `本任务已介入 ${input.interventions} 次，为避免刷屏已停止发送；请直接结束或重新发起任务。`,
    };
  }
  if (
    input.lastInterventionAt !== null &&
    input.lastInterventionAction === input.actionType &&
    input.now - input.lastInterventionAt < INTERVENE_COOLDOWN_MS
  ) {
    return {
      allowed: false,
      reason: "duplicate",
      detail: "刚才已经发过同一条介入指令，请等模型响应后再试。",
    };
  }
  return { allowed: true };
}
