import type { AssistantMessage, Context, Model, Api } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { contentToText } from "./ltm/observe-hooks.ts";

/**
 * Auto session titles ("ChatGPT-style").
 *
 * Runs once per session, in the background, after the first turn settles.
 * Uses pi's own ModelRuntime so credentials / provider config / extension
 * providers are reused — no separate client, no extra network layer.
 * The result is written with `AgentSession.setSessionName`, i.e. a normal
 * `session_info` entry, which pi persists and broadcasts as
 * `session_info_changed`.
 */

export const MAX_TITLE_LENGTH = 15;

const TITLE_SYSTEM_PROMPT = [
  "You write very short titles for coding-assistant conversations.",
  `Rules: at most ${MAX_TITLE_LENGTH} characters.`,
  "Same language as the user's message. No quotes, no trailing punctuation, no prefix like 'Title:'.",
  "Describe the concrete task (feature/file/bug), not the mood.",
].join(" ");

export interface TitleTarget {
  readonly model: Model<Api> | undefined;
  readonly modelRuntime: Pick<ModelRuntime, "complete">;
}

/** First user message text from session branch entries. */
export function firstUserTextFromBranch(entries: unknown[]): string {
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (e.type !== "message" || !e.message || typeof e.message !== "object") continue;
    const message = e.message as Record<string, unknown>;
    if (message.role !== "user") continue;
    const text = contentToText(message.content).trim();
    if (text) return text;
  }
  return "";
}

/** Number of user messages in a branch (used to detect "first turn only"). */
export function countUserMessages(entries: unknown[]): number {
  let count = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (e.type !== "message" || !e.message || typeof e.message !== "object") continue;
    if ((e.message as Record<string, unknown>).role === "user") count += 1;
  }
  return count;
}

/**
 * Manual names always win; only the first user turn may be auto-named.
 * Extracted so the priority rule is testable outside the RPC manager.
 */
export function shouldAutoNameSession(
  sessionName: string | null | undefined,
  userMessageCount: number,
): boolean {
  return !sessionName?.trim() && userMessageCount === 1;
}

/** Normalise a raw model response into a display title, or null if unusable. */
export function sanitizeTitle(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let title = raw
    .split(/\r?\n/)[0]
    .replace(/^\s*(?:title|标题)\s*[:：]\s*/i, "")
    .replace(/^["'`“”‘’「」『』]+|["'`“”‘’「」『』]+$/g, "")
    .replace(/[。．.！!？?；;，,、\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!title) return null;
  if (title.length > MAX_TITLE_LENGTH) {
    title = Array.from(title).slice(0, MAX_TITLE_LENGTH).join("").trim();
  }
  return title || null;
}

/** Cheap fallback when the model call fails: first characters of the prompt. */
function fallbackTitle(text: string): string | null {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return sanitizeTitle(Array.from(cleaned).slice(0, MAX_TITLE_LENGTH).join(""));
}

function assistantText(message: AssistantMessage): string {
  return contentToText(message.content).trim();
}

/**
 * Ask the active model for a ≤15 character title.
 * Returns null when no model is available or the request fails.
 */
export async function generateSessionTitle(
  target: TitleTarget,
  firstUserText: string,
): Promise<string | null> {
  const prompt = firstUserText.trim();
  if (!prompt) return null;
  if (!target.model) return fallbackTitle(prompt);

  const context: Context = {
    systemPrompt: TITLE_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: prompt.slice(0, 2000) }],
        timestamp: Date.now(),
      },
    ],
  };

  try {
    const result = await target.modelRuntime.complete(target.model, context, {
      maxTokens: 48,
      temperature: 0.2,
    });
    return sanitizeTitle(assistantText(result)) ?? fallbackTitle(prompt);
  } catch (error) {
    console.error("Session title generation failed:", error);
    return fallbackTitle(prompt);
  }
}
