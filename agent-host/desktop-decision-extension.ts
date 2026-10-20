/**
 * Inline pi extension: `classify_decision`.
 *
 * The agent can ask the configured decision/classifier model for a cheap,
 * structured answer (choice / score / boolean) — for example to triage risk or
 * pick a category — without spending a full main-model turn on it. The model
 * call runs in the Agent Host through `agent-host/aux-models.ts`.
 */
import { Type } from "typebox";
import type {
  ExtensionAPI,
  ExtensionFactory,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";
import type {
  DecisionQuestion,
  DecisionReport,
} from "../contract/domains/aux-models.ts";
import { AuxModelError, classifyDecision } from "./aux-models.ts";
import { CLASSIFY_DECISION_TOOL_NAME } from "./aux-tool-names.ts";

export { CLASSIFY_DECISION_TOOL_NAME };

const ClassifyDecisionParams = Type.Object({
  question: Type.String({
    description: "The decision question, with enough context for a standalone judgement.",
  }),
  mode: Type.Union(
    [
      Type.Literal("choice"),
      Type.Literal("score"),
      Type.Literal("bool"),
    ],
    { description: "choice = pick one option, score = graded judgement, bool = yes/no probability." },
  ),
  choices: Type.Optional(
    Type.Array(Type.String(), {
      description: "Option labels for mode=choice. Required for choice.",
    }),
  ),
  criteria: Type.Optional(
    Type.Array(Type.String(), {
      description: "Rubric items for mode=score (what a high score means).",
    }),
  ),
  trueLabel: Type.Optional(Type.String({ description: "Label for the true outcome (mode=bool)." })),
  falseLabel: Type.Optional(Type.String({ description: "Label for the false outcome (mode=bool)." })),
  state: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: "Structured JSON state the decision is about (code diff, plan, message, metadata).",
    }),
  ),
});

/** Tool result details the transcript reads to render decision badges. */
export interface DecisionToolDetails {
  kind: "decision";
  ok: boolean;
  mode: string;
  provider?: string;
  model?: string;
  questions: string[];
  answers: DecisionReport["answers"];
  elapsedMs?: number;
  error?: string;
}

function describeAnswer(report: DecisionReport): string {
  const lines: string[] = [];
  for (const [key, answer] of Object.entries(report.answers)) {
    if (answer.kind === "choice") {
      const confidence =
        typeof answer.confidence === "number" ? ` (confidence ${(answer.confidence * 100).toFixed(0)}%)` : "";
      const distribution = answer.probabilities
        ? Object.entries(answer.probabilities)
            .sort((a, b) => b[1] - a[1])
            .map(([choice, probability]) => `${choice} ${(probability * 100).toFixed(0)}%`)
            .join(", ")
        : "";
      lines.push(`${key}: ${answer.choice}${confidence}`);
      if (distribution) lines.push(`distribution: ${distribution}`);
    } else if (answer.kind === "score") {
      const confidence =
        typeof answer.confidence === "number" ? ` (confidence ${(answer.confidence * 100).toFixed(0)}%)` : "";
      lines.push(`${key}: score ${answer.score}${confidence}`);
    } else {
      lines.push(`${key}: probability ${answer.probability}`);
    }
  }
  return lines.join("\n");
}

export function createDesktopDecisionFactory(): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: CLASSIFY_DECISION_TOOL_NAME,
      label: "Classify Decision",
      description:
        "Ask the user's configured decision (classifier) model for a cheap structured judgement: pick one option, " +
        "produce a score, or estimate a yes/no probability. Use it for triage, risk gates, or routing between " +
        "approaches instead of reasoning it out with the main model.",
      promptSnippet: "Classify a decision with the configured decision model",
      promptGuidelines: [
        "Use classify_decision for short structured judgements (triage, category, go/no-go), not for explanations.",
        "Pass the relevant state as JSON so the decision model can judge without extra context.",
      ],
      parameters: ClassifyDecisionParams,
      defaultActive: false,
      async execute(_toolCallId, params) {
        const question: DecisionQuestion = {
          key: "decision",
          mode: params.mode,
          instructions: params.question,
          ...(params.choices ? { choices: params.choices } : {}),
          ...(params.criteria ? { criteria: params.criteria } : {}),
          ...(params.trueLabel ? { trueLabel: params.trueLabel } : {}),
          ...(params.falseLabel ? { falseLabel: params.falseLabel } : {}),
        };
        try {
          const report = await classifyDecision({
            state: params.state ?? { question: params.question },
            questions: [question],
          });
          const details: DecisionToolDetails = {
            kind: "decision",
            ok: report.ok,
            mode: params.mode,
            ...(report.provider ? { provider: report.provider } : {}),
            ...(report.model ? { model: report.model } : {}),
            questions: [params.question],
            answers: report.answers,
            elapsedMs: report.elapsedMs,
            ...(report.error ? { error: report.error } : {}),
          };
          if (!report.ok) {
            return {
              content: [
                { type: "text" as const, text: `Decision model failed: ${report.error ?? "unknown error"}` },
              ],
              details,
            };
          }
          const summary = [
            `Decision (${report.provider}/${report.model}):`,
            describeAnswer(report),
          ]
            .filter(Boolean)
            .join("\n");
          return {
            content: [{ type: "text" as const, text: summary }],
            details,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [
              {
                type: "text" as const,
                text: error instanceof AuxModelError ? message : `Decision model failed: ${message}`,
              },
            ],
            details: {
              kind: "decision",
              ok: false,
              mode: params.mode,
              questions: [params.question],
              answers: {},
              error: message,
            } satisfies DecisionToolDetails,
          };
        }
      },
    });
  };
}

export function desktopDecisionInlineExtension(): InlineExtension {
  return {
    name: "desktop-decision-model",
    factory: createDesktopDecisionFactory(),
  };
}
