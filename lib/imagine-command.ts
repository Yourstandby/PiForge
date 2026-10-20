/**
 * `/imagine <prompt>` handling.
 *
 * The slash command is a UI affordance: it rewrites the outgoing user message
 * into an instruction that names the `generate_image` tool, so the Agent runs
 * the Host-side image model (and the image lands in the transcript as a normal
 * tool result).
 */

export const IMAGINE_COMMAND = "/imagine";

const IMAGINE_PREFIX = /^\/imagine(?:\s+|$)/i;

/** True when the composer text is the imagine command (with or without a prompt). */
export function isImagineCommand(value: string): boolean {
  return IMAGINE_PREFIX.test(value.trim());
}

/**
 * Rewrite `/imagine a cat` into an agent instruction.
 * Returns null when the text is not the command, and an empty string when the
 * command has no prompt yet.
 */
export function buildImagineMessage(value: string): string | null {
  const trimmed = value.trim();
  if (!isImagineCommand(trimmed)) return null;
  const prompt = trimmed.replace(IMAGINE_PREFIX, "").trim();
  if (!prompt) return "";
  return [
    `请使用 generate_image 工具生成一张图片。`,
    "",
    `图片描述：${prompt}`,
  ].join("\n");
}
