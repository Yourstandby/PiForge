/**
 * "Auto" model routing.
 *
 * The user picks Auto once; every prompt is classified by a cheap heuristic and
 * routed to either the configured fast or strong model. No extra LLM call is
 * made for routing (a classifier round-trip would cost more than it saves).
 */

export interface ModelRef {
  provider: string;
  id: string;
  name: string;
}

export type AutoTier = "fast" | "strong";

export interface AutoRoutingTargets {
  fast: { provider: string; modelId: string } | null;
  strong: { provider: string; modelId: string } | null;
}

/** Fast/small model name hints, strongest first. */
const FAST_HINTS = [
  "haiku",
  "mini",
  "flash",
  "nano",
  "lite",
  "small",
  "instant",
  "turbo",
  "8b",
  "7b",
  "3b",
  "1.5b",
  "qwen-turbo",
  "deepseek-chat",
  "gpt-4.1-nano",
];

/** Strong/reasoning model name hints, strongest first. */
const STRONG_HINTS = [
  "opus",
  "o3",
  "o4",
  "gpt-5",
  "gpt-4.1",
  "sonnet",
  "pro",
  "max",
  "reasoner",
  "r1",
  "qwen3-max",
  "gemini-2.5-pro",
  "composer",
  "k2",
  "deepseek-reasoner",
];

function score(model: ModelRef, hints: readonly string[]): number {
  const haystack = `${model.id} ${model.name}`.toLowerCase();
  for (let i = 0; i < hints.length; i++) {
    if (haystack.includes(hints[i])) return hints.length - i;
  }
  return 0;
}

/**
 * Pick fast/strong targets from the available models.
 * `fallback` (the user's default model) is preferred as the strong tier when
 * no explicit reasoning-model hint matches.
 */
export function pickAutoTargets(
  models: ModelRef[],
  fallback?: { provider: string; modelId: string } | null,
): AutoRoutingTargets {
  if (models.length === 0) return { fast: null, strong: null };

  const toRef = (model: ModelRef) => ({ provider: model.provider, modelId: model.id });

  const byStrong = [...models].sort((a, b) => score(b, STRONG_HINTS) - score(a, STRONG_HINTS));
  const byFast = [...models].sort((a, b) => score(b, FAST_HINTS) - score(a, FAST_HINTS));

  let strongModel: ModelRef | undefined;
  if (fallback) {
    const match = models.find(
      (m) => m.id === fallback.modelId && m.provider === fallback.provider,
    );
    if (match && score(match, STRONG_HINTS) > 0) strongModel = match;
  }
  strongModel ??= byStrong.find((m) => score(m, STRONG_HINTS) > 0) ?? byStrong[0];

  let fastModel = byFast.find((m) => score(m, FAST_HINTS) > 0);
  if (!fastModel) {
    // No obvious small model: use the strong model rather than guessing.
    fastModel = strongModel;
  }
  if (fastModel.id === strongModel.id && fastModel.provider === strongModel.provider) {
    // Prefer any distinct model for the fast tier if one exists.
    const distinct = byFast.find(
      (m) => m.id !== strongModel!.id || m.provider !== strongModel!.provider,
    );
    if (distinct) fastModel = distinct;
  }

  return { fast: toRef(fastModel), strong: toRef(strongModel) };
}

const COMPLEX_PATTERNS = [
  /refactor/i,
  /architect/i,
  /design/i,
  /debug/i,
  /why\b/i,
  /explain/i,
  /analy[sz]e/i,
  /optimi[sz]e/i,
  /migrat/i,
  /implement/i,
  /review/i,
  /plan\b/i,
  /重构/,
  /架构/,
  /设计/,
  /调试/,
  /为什么/,
  /分析/,
  /优化/,
  /实现/,
  /迁移/,
  /排查/,
  /方案/,
  /规划/,
  /审查/,
];

/**
 * Classify a prompt. Complex when it is long, asks for reasoning/design work,
 * contains code, or carries images. Short "what is X / rename this" style
 * prompts go to the fast model.
 */
export function classifyPromptComplexity(
  message: string,
  hasImages = false,
  contextChars = 0,
): AutoTier {
  const text = message.trim();
  if (hasImages) return "strong";
  // A long conversation benefits from the stronger model even when the new
  // prompt itself is short (the model still has to reason over all of it).
  if (contextChars > 40_000) return "strong";
  if (text.length > 420) return "strong";
  if (/```/.test(text)) return "strong";
  if ((text.match(/\?/g) ?? []).length >= 3) return "strong";
  if (COMPLEX_PATTERNS.some((pattern) => pattern.test(text))) return "strong";
  // Multiple file references / a long list usually means a multi-file change.
  if ((text.match(/@[\w./\\-]+/g) ?? []).length >= 2) return "strong";
  return "fast";
}

export function resolveAutoModel(
  targets: AutoRoutingTargets,
  tier: AutoTier,
): { provider: string; modelId: string } | null {
  return targets[tier] ?? targets.strong ?? targets.fast ?? null;
}
