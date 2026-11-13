/**
 * Inline pi extension: `plan` 工具 —— 结构化计划进度。
 *
 * 模型自己维护步骤状态（全量 steps 一次列计划，之后只发增量 update），
 * 前端把最后一次调用渲染成输入框上方的进度卡片（`lib/plan-progress.ts`）。
 * 工具返回值只有一个 `ok`：状态已经在参数里，回显它纯属白烧 token。
 *
 * 设置项 `planProgressEnabled === false` 时**整个扩展不注册**：既不声明工具
 * （省一整套 schema），也不注入提示词。改动从新会话起生效。
 */
import { Type } from "typebox";
import type {
  ExtensionAPI,
  ExtensionFactory,
  InlineExtension,
} from "./sdk-adapter.ts";
import {
  PLAN_MAX_STEPS,
  PLAN_TOOL_NAME,
  readPlanSteps,
  readPlanUpdate,
} from "../lib/plan-progress.ts";

/** 与输出风格同一注入机制（promptGuidelines 是提示词的稳定尾段，前缀缓存不抖）。 */
export const PLAN_PROGRESS_GUIDELINES: readonly string[] = [
  "## 计划进度（plan 工具）",
  "- 接到需要多步完成的任务时，先调一次 `plan` 传全量 steps：3–7 步，动词开头的短句（≤16 字），不写文件路径与行号。",
  "- 之后只用 `update: {index, status}` 推进：开始做某步设 active，做完立刻设 done；不要重传全量 steps。",
  "- 只在状态真的变化时调用；步骤增删或顺序变了才重传全量 steps。全部 done 后停止调用。",
  "- plan 只维护界面进度，不替代正式回复；返回值只有 ok，不要复述它。",
];

const StepParams = Type.Object({
  title: Type.String({
    description: "步骤短标题：动词开头，≤16 字，不带文件路径 / 行号",
  }),
  status: Type.Optional(
    Type.String({ description: "pending | active | done（缺省 pending）" })
  ),
});

const PlanParams = Type.Object({
  steps: Type.Optional(
    Type.Array(StepParams, {
      description: `完整步骤列表（全量，1–${PLAN_MAX_STEPS} 条）。首次调用必传；步骤增删或顺序变了再传全量`,
    })
  ),
  update: Type.Optional(
    Type.Object(
      {
        index: Type.Number({ description: "步骤下标，从 0 开始" }),
        status: Type.String({ description: "done | active | pending" }),
      },
      { description: "增量推进：只改某一步的状态，比重传全量省 token" }
    )
  ),
});

function result(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

export type DesktopPlanExtensionOptions = {
  /** 关掉时整个扩展不注册（工具 schema + 提示词都不出现）。 */
  enabled?: () => boolean;
};

export function createDesktopPlanFactory(
  options?: DesktopPlanExtensionOptions
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    if (options?.enabled && !options.enabled()) return;

    pi.on("before_agent_start", (event) => {
      const promptOptions = event.systemPromptOptions;
      const existing = promptOptions.promptGuidelines ?? [];
      const missing = PLAN_PROGRESS_GUIDELINES.filter(
        (line) => !existing.includes(line)
      );
      if (missing.length === 0) return;
      promptOptions.promptGuidelines = [...existing, ...missing];
    });

    pi.registerTool({
      name: PLAN_TOOL_NAME,
      label: "Plan",
      description:
        "维护当前任务的计划进度清单：先传全量 steps 列计划，之后用 update 增量推进某一步的状态。" +
        "用户界面会把最后一次调用渲染成输入框上方的进度卡片。",
      promptSnippet: "Maintain the task plan checklist shown above the composer",
      parameters: PlanParams,
      async execute(_toolCallId: string, params: unknown) {
        const args = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
        const steps = readPlanSteps(args.steps);
        const update = readPlanUpdate(args.update);
        if (!steps && !update) {
          return result(
            "需要 steps（全量步骤列表）或 update（{index,status}）之一。首次调用传 steps。",
            { error: "invalid_plan" }
          );
        }
        return result("ok");
      },
    });
  };
}

export function desktopPlanInlineExtension(
  options?: DesktopPlanExtensionOptions
): InlineExtension {
  return {
    name: "desktop-plan",
    factory: createDesktopPlanFactory(options),
  };
}
