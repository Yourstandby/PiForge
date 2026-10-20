/**
 * Inline pi extension: `generate_image`.
 *
 * The agent asks the configured image-generation model (Settings → 辅助模型)
 * for an image and receives it as a tool result, so the UI can render the
 * picture directly in the transcript. The API call itself runs in the Agent
 * Host through `agent-host/aux-models.ts`.
 */
import { Type } from "typebox";
import type {
  ExtensionAPI,
  ExtensionFactory,
  InlineExtension,
} from "./sdk-adapter.ts";
import type { ImageGenerationReport } from "../contract/domains/aux-models.ts";
import { AuxModelError, generateImage } from "./aux-models.ts";
import { GENERATE_IMAGE_TOOL_NAME } from "./aux-tool-names.ts";

export { GENERATE_IMAGE_TOOL_NAME };

const GenerateImageParams = Type.Object({
  prompt: Type.String({
    description:
      "Detailed image description (subject, style, composition, lighting, colors). English prompts usually work best.",
  }),
});

function failure(text: string, details: Partial<ImageToolDetails>) {
  return {
    content: [{ type: "text" as const, text }],
    details: { kind: "image-generation", ok: false, ...details } satisfies ImageToolDetails,
  };
}

/** Tool result details the transcript reads to label the card. */
export interface ImageToolDetails {
  kind: "image-generation";
  ok: boolean;
  provider?: string;
  model?: string;
  prompt?: string;
  count?: number;
  mimeType?: string;
  elapsedMs?: number;
  error?: string;
}

export function reportToDetails(report: ImageGenerationReport): ImageToolDetails {
  return {
    kind: "image-generation",
    ok: report.ok,
    ...(report.provider ? { provider: report.provider } : {}),
    ...(report.model ? { model: report.model } : {}),
    prompt: report.prompt,
    count: report.images.length,
    ...(report.images[0]?.mimeType ? { mimeType: report.images[0].mimeType } : {}),
    elapsedMs: report.elapsedMs,
    ...(report.error ? { error: report.error } : {}),
  };
}

export function createDesktopImageFactory(): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: GENERATE_IMAGE_TOOL_NAME,
      label: "Generate Image",
      description:
        "Generate an image from a text prompt with the user's configured image model. " +
        "Use it when the user asks for a picture, illustration, icon, logo concept, UI mockup art, or " +
        "diagram artwork. The generated image is shown to the user and returned to you as an image.",
      promptSnippet: "Generate an image from a text prompt",
      promptGuidelines: [
        "Call generate_image only when the user asks for a picture or illustration; use read/write for code and text.",
        "Write a single detailed prompt for generate_image; do not split one request into several calls unless the user asks for variants.",
      ],
      parameters: GenerateImageParams,
      defaultActive: false,
      async execute(_toolCallId, params) {
        try {
          const report = await generateImage(params.prompt);
          const details = reportToDetails(report);
          if (!report.ok) {
            return failure(`Image generation failed: ${report.error ?? "unknown error"}`, details);
          }
          const summary = [
            `Generated ${report.images.length} image${report.images.length === 1 ? "" : "s"} with ${report.provider}/${report.model}.`,
            "The image is attached to this tool result and displayed in the conversation.",
            report.text ? `Model notes: ${report.text}` : "",
          ]
            .filter(Boolean)
            .join("\n");
          return {
            content: [
              { type: "text" as const, text: summary },
              ...report.images.map((image) => ({
                type: "image" as const,
                data: image.data,
                mimeType: image.mimeType,
              })),
            ],
            details,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return failure(
            error instanceof AuxModelError
              ? message
              : `Image generation failed: ${message}`,
            { error: message },
          );
        }
      },
    });
  };
}

export function desktopImageInlineExtension(): InlineExtension {
  return {
    name: "desktop-image-generation",
    factory: createDesktopImageFactory(),
  };
}
