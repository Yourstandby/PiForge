/**
 * Auxiliary (non-chat) models: image generation and structured decisions.
 *
 * The catalogue, credential resolution and every API call run in the Agent
 * Host. Next.js only proxies these DTOs.
 */

export interface AuxModelSelection {
  provider: string;
  modelId: string;
}

export interface AuxModelOption {
  provider: string;
  /** Human-readable provider name for the settings dropdown. */
  providerName: string;
  id: string;
  name: string;
}

export interface AuxModelConfig {
  image: AuxModelSelection | null;
  decision: AuxModelSelection | null;
}

export interface AuxModelCatalogue {
  /** Image-generation models whose provider has credentials. */
  image: AuxModelOption[];
  /** Classifier/decision models whose provider has credentials. */
  classifier: AuxModelOption[];
  /** Currently persisted selection (null = not configured). */
  config: AuxModelConfig;
}

export interface GeneratedImage {
  /** Base64 payload (no data: prefix). */
  data: string;
  mimeType: string;
}

export interface ImageGenerationReport {
  ok: boolean;
  provider?: string;
  model?: string;
  prompt: string;
  images: GeneratedImage[];
  /** Text the model returned alongside the images, when any. */
  text?: string;
  error?: string;
  elapsedMs: number;
}

export type DecisionQuestionMode = "choice" | "score" | "bool";

/**
 * One structured question. `choice` needs `choices`, `score` uses `criteria`
 * as the rubric, and `bool` may customise the two labels.
 */
export interface DecisionQuestion {
  key: string;
  mode: DecisionQuestionMode;
  instructions: string;
  /** Option labels for `choice` (also used as the criteria descriptions). */
  choices?: string[];
  /** Rubric items for `score`. */
  criteria?: string[];
  trueLabel?: string;
  falseLabel?: string;
}

export interface DecisionAnswer {
  kind: DecisionQuestionMode;
  /** `choice` result. */
  choice?: string;
  /** `score` result. */
  score?: number;
  /** `bool` result. */
  probability?: number;
  /** `choice` / `score` confidence in [0, 1]. */
  confidence?: number;
  /** Full `choice` distribution. */
  probabilities?: Record<string, number>;
}

export interface DecisionReport {
  ok: boolean;
  provider?: string;
  model?: string;
  answers: Record<string, DecisionAnswer>;
  stopReason?: string;
  error?: string;
  elapsedMs: number;
}
