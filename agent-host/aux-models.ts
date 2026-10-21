/**
 * Auxiliary model service (v0.5.0 stage 2).
 *
 * Owns the non-chat model lanes that Pi exposes through `ModelRuntime`:
 * image generation (`generate_image`) and structured decisions
 * (`classify_decision`). Catalogue lookups, credential resolution and the
 * actual API calls stay in the Agent Host; Next.js only proxies DTOs.
 *
 * Selections are persisted in `desktop-settings.json` next to the Auto-routing
 * choices, so the settings panel and the agent tools read the same source.
 */
import { join } from "node:path";
import { ModelRuntime, getAgentDir } from "./sdk-adapter.ts";
import type {
  ClassifierAnswer,
  ClassifierContext,
  ClassifierModel,
  ClassifierQuestion,
  ImageContent,
  ImageModel,
  TextContent,
} from "./sdk-adapter.ts";
import {
  readDesktopSettings,
  writeDesktopSettings,
  type AuxModelSelection,
} from "../lib/desktop-settings.ts";
import type {
  AuxModelCatalogue,
  AuxModelConfig,
  AuxModelOption,
  DecisionAnswer,
  DecisionQuestion,
  DecisionReport,
  GeneratedImage,
  ImageGenerationReport,
} from "../contract/domains/aux-models.ts";

const MAX_IMAGES = 4;
/** Keep one RPC response under the 8 MB frame cap (base64 inflates binary ~4/3). */
const MAX_TOTAL_IMAGE_CHARS = 6_000_000;

export type AuxModelErrorCode =
  | "AUX_MODEL_NOT_CONFIGURED"
  | "AUX_MODEL_FAILED"
  | "E_INVALID_PARAMS";

export class AuxModelError extends Error {
  readonly code: AuxModelErrorCode;

  constructor(code: AuxModelErrorCode, message: string) {
    super(message);
    this.name = "AuxModelError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Runtime singleton
// ---------------------------------------------------------------------------

let runtimePromise: Promise<ModelRuntime> | null = null;

/**
 * A dedicated runtime for auxiliary calls. Sessions keep their own runtime;
 * this one is refreshed whenever credentials or models.json change.
 */
function getRuntime(): Promise<ModelRuntime> {
  runtimePromise ??= ModelRuntime.create({
    authPath: join(getAgentDir(), "auth.json"),
    modelsPath: join(getAgentDir(), "models.json"),
    allowModelNetwork: false,
  }).catch((error: unknown) => {
    runtimePromise = null;
    throw error;
  });
  return runtimePromise;
}

/** Shared runtime for auxiliary calls and sub-agent sessions. */
export function getSharedAuxRuntime(): Promise<ModelRuntime> {
  return getRuntime();
}

/** Credentials or models.json changed: the next call rebuilds the runtime. */
export function invalidateAuxRuntime(): void {
  runtimePromise = null;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export function readAuxConfig(): AuxModelConfig {
  const settings = readDesktopSettings(getAgentDir());
  return {
    image: settings.imageModel ?? null,
    decision: settings.decisionModel ?? null,
  };
}

/** Tools are only declared to the model once the user picked a model. */
export function auxToolAvailability(): { image: boolean; decision: boolean } {
  try {
    const config = readAuxConfig();
    return { image: Boolean(config.image), decision: Boolean(config.decision) };
  } catch {
    return { image: false, decision: false };
  }
}

function isSelection(value: unknown): value is AuxModelSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.provider === "string" && Boolean(obj.provider.trim()) &&
    typeof obj.modelId === "string" && Boolean(obj.modelId.trim());
}

function normalizeSelection(value: AuxModelSelection): AuxModelSelection {
  return { provider: value.provider.trim(), modelId: value.modelId.trim() };
}

function toOption(runtime: ModelRuntime, model: { provider: string; id: string; name: string }): AuxModelOption {
  return {
    provider: model.provider,
    providerName: runtime.getProvider(model.provider)?.name ?? model.provider,
    id: model.id,
    name: model.name || model.id,
  };
}

export async function getAuxCatalogue(): Promise<AuxModelCatalogue> {
  const runtime = await getRuntime();
  const [image, classifier] = await Promise.all([
    runtime.getAvailableOfType("image"),
    runtime.getAvailableOfType("classifier"),
  ]);
  const sortOptions = (options: AuxModelOption[]) =>
    options.sort((a, b) =>
      a.providerName.localeCompare(b.providerName) || a.name.localeCompare(b.name),
    );
  return {
    image: sortOptions(image.map((model) => toOption(runtime, model))),
    classifier: sortOptions(classifier.map((model) => toOption(runtime, model))),
    config: readAuxConfig(),
  };
}

async function assertModelExists(
  runtime: ModelRuntime,
  type: "image" | "classifier",
  selection: AuxModelSelection,
): Promise<void> {
  const model = runtime.getModelOfType(type, selection.provider, selection.modelId);
  if (!model) {
    const label = type === "image" ? "image-generation" : "decision";
    throw new AuxModelError(
      "E_INVALID_PARAMS",
      `Unknown ${label} model: ${selection.provider}/${selection.modelId}`,
    );
  }
}

/** Persist one or both selections. `null` clears the selection. */
export async function setAuxConfig(patch: {
  image?: AuxModelSelection | null;
  decision?: AuxModelSelection | null;
}): Promise<AuxModelConfig> {
  if (patch.image !== undefined && patch.image !== null && !isSelection(patch.image)) {
    throw new AuxModelError("E_INVALID_PARAMS", "image must be {provider, modelId} or null");
  }
  if (patch.decision !== undefined && patch.decision !== null && !isSelection(patch.decision)) {
    throw new AuxModelError("E_INVALID_PARAMS", "decision must be {provider, modelId} or null");
  }
  const runtime = await getRuntime();
  const image = patch.image === null ? null : patch.image ? normalizeSelection(patch.image) : undefined;
  const decision = patch.decision === null ? null : patch.decision ? normalizeSelection(patch.decision) : undefined;
  if (image) await assertModelExists(runtime, "image", image);
  if (decision) await assertModelExists(runtime, "classifier", decision);

  const agentDir = getAgentDir();
  const current = readDesktopSettings(agentDir);
  const next = { ...current };
  if (image !== undefined) {
    if (image) next.imageModel = image;
    else delete next.imageModel;
  }
  if (decision !== undefined) {
    if (decision) next.decisionModel = decision;
    else delete next.decisionModel;
  }
  writeDesktopSettings(agentDir, next);
  return readAuxConfig();
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

async function resolveImageModel(selection?: AuxModelSelection | null): Promise<ImageModel<string>> {
  const runtime = await getRuntime();
  if (selection) {
    const model = runtime.getModelOfType("image", selection.provider, selection.modelId);
    if (!model) {
      throw new AuxModelError(
        "AUX_MODEL_NOT_CONFIGURED",
        `Image model ${selection.provider}/${selection.modelId} is not available`,
      );
    }
    return model as ImageModel<string>;
  }
  const configured = readAuxConfig().image;
  if (configured) {
    const model = runtime.getModelOfType("image", configured.provider, configured.modelId);
    if (model) return model as ImageModel<string>;
  }
  const available = await runtime.getAvailableOfType("image");
  if (available.length === 0) {
    throw new AuxModelError(
      "AUX_MODEL_NOT_CONFIGURED",
      "No image-generation model is available. Add provider credentials (for example OpenRouter) and pick a model in Settings → 辅助模型.",
    );
  }
  return available[0] as ImageModel<string>;
}

async function resolveDecisionModel(selection?: AuxModelSelection | null): Promise<ClassifierModel<string>> {
  const runtime = await getRuntime();
  if (selection) {
    const model = runtime.getModelOfType("classifier", selection.provider, selection.modelId);
    if (!model) {
      throw new AuxModelError(
        "AUX_MODEL_NOT_CONFIGURED",
        `Decision model ${selection.provider}/${selection.modelId} is not available`,
      );
    }
    return model as ClassifierModel<string>;
  }
  const configured = readAuxConfig().decision;
  if (configured) {
    const model = runtime.getModelOfType("classifier", configured.provider, configured.modelId);
    if (model) return model as ClassifierModel<string>;
  }
  const available = await runtime.getAvailableOfType("classifier");
  if (available.length === 0) {
    throw new AuxModelError(
      "AUX_MODEL_NOT_CONFIGURED",
      "No decision (classifier) model is available. Add provider credentials and pick a model in Settings → 辅助模型.",
    );
  }
  return available[0] as ClassifierModel<string>;
}

// ---------------------------------------------------------------------------
// Image generation
// ---------------------------------------------------------------------------

function imageContent(block: { type: string }): block is ImageContent {
  return block.type === "image";
}

export async function generateImage(
  prompt: string,
  selection?: AuxModelSelection | null,
): Promise<ImageGenerationReport> {
  const trimmed = prompt?.trim();
  if (!trimmed) throw new AuxModelError("E_INVALID_PARAMS", "prompt is required");
  const startedAt = Date.now();
  const model = await resolveImageModel(selection);
  const runtime = await getRuntime();
  const result = await runtime.generateImages(model, {
    input: [{ type: "text", text: trimmed }],
  });
  const images: GeneratedImage[] = [];
  let totalChars = 0;
  for (const block of result.output.filter(imageContent)) {
    if (images.length >= MAX_IMAGES) break;
    if (totalChars + block.data.length > MAX_TOTAL_IMAGE_CHARS) break;
    images.push({ data: block.data, mimeType: block.mimeType });
    totalChars += block.data.length;
  }
  const text = result.output
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  const failed = result.stopReason === "error" || Boolean(result.errorMessage);
  const error = failed
    ? result.errorMessage || "Image generation failed"
    : images.length === 0
      ? "The model returned no image."
      : undefined;
  return {
    ok: !error,
    provider: result.provider,
    model: result.model || model.id,
    prompt: trimmed,
    images,
    ...(text ? { text } : {}),
    ...(error ? { error } : {}),
    elapsedMs: Date.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// Structured decisions
// ---------------------------------------------------------------------------

function toClassifierQuestion(question: DecisionQuestion): ClassifierQuestion {
  const instructions = question.instructions?.trim();
  if (!instructions) {
    throw new AuxModelError("E_INVALID_PARAMS", `question "${question.key}" needs instructions`);
  }
  if (question.mode === "choice") {
    const choices = (question.choices ?? []).map((choice) => choice.trim()).filter(Boolean);
    if (choices.length === 0) {
      throw new AuxModelError(
        "E_INVALID_PARAMS",
        `question "${question.key}" needs at least one choice`,
      );
    }
    return {
      type: "choice",
      instructions,
      criteria: Object.fromEntries(choices.map((choice) => [choice, choice])),
    };
  }
  if (question.mode === "score") {
    const rubric = (question.criteria ?? []).map((item) => item.trim()).filter(Boolean);
    return {
      type: "score",
      instructions,
      criteria: rubric.length > 0 ? rubric : [instructions],
    };
  }
  return {
    type: "bool",
    instructions,
    criteria: {
      true: question.trueLabel?.trim() || "true",
      false: question.falseLabel?.trim() || "false",
    },
  };
}

function toDecisionAnswer(answer: ClassifierAnswer): DecisionAnswer {
  if (answer.type === "choice") {
    return {
      kind: "choice",
      choice: answer.choice,
      confidence: answer.confidence,
      probabilities: answer.probabilities,
    };
  }
  if (answer.type === "score") {
    return { kind: "score", score: answer.score, confidence: answer.confidence };
  }
  return { kind: "bool", probability: answer.probability };
}

export async function classifyDecision(input: {
  state: Record<string, unknown>;
  questions: DecisionQuestion[];
  model?: AuxModelSelection | null;
}): Promise<DecisionReport> {
  if (!input.questions || input.questions.length === 0) {
    throw new AuxModelError("E_INVALID_PARAMS", "questions must not be empty");
  }
  const questions: Record<string, ClassifierQuestion> = {};
  for (const question of input.questions) {
    if (!question.key?.trim()) {
      throw new AuxModelError("E_INVALID_PARAMS", "every question needs a key");
    }
    questions[question.key.trim()] = toClassifierQuestion(question);
  }
  const startedAt = Date.now();
  const model = await resolveDecisionModel(input.model);
  const runtime = await getRuntime();
  const result = await runtime.classify(model, {
    state: input.state as ClassifierContext["state"],
    questions,
  });
  const answers: Record<string, DecisionAnswer> = {};
  for (const [key, answer] of Object.entries(result.answers ?? {})) {
    answers[key] = toDecisionAnswer(answer);
  }
  const failed = result.stopReason === "error" || Boolean(result.errorMessage);
  return {
    ok: !failed,
    provider: result.provider,
    model: result.model || model.id,
    answers,
    stopReason: result.stopReason,
    ...(failed ? { error: result.errorMessage || "Decision model failed" } : {}),
    elapsedMs: Date.now() - startedAt,
  };
}
