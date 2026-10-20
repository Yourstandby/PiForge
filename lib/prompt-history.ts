/**
 * Prompt history for the composer (terminal-style ↑ / ↓).
 *
 * Stored newest-first in localStorage; a consecutive duplicate is not stored
 * twice so holding Enter does not fill the list with the same prompt.
 */

export const PROMPT_HISTORY_KEY = "piforge.promptHistory";
export const PROMPT_HISTORY_LIMIT = 100;
export const PROMPT_HISTORY_MAX_LENGTH = 8_000;

/** Newest-first list with the submitted prompt on top. */
export function pushPromptHistory(
  history: readonly string[],
  prompt: string,
  limit: number = PROMPT_HISTORY_LIMIT,
): string[] {
  const text = prompt.trim();
  if (!text || text.length > PROMPT_HISTORY_MAX_LENGTH) return [...history];
  if (history[0] === text) return [...history];
  return [text, ...history.filter((entry) => entry !== text)].slice(0, limit);
}

/** Parse a stored JSON array defensively (older/corrupt values fall back). */
export function parsePromptHistory(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .slice(0, PROMPT_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

export function readPromptHistory(): string[] {
  if (typeof window === "undefined") return [];
  try {
    return parsePromptHistory(window.localStorage.getItem(PROMPT_HISTORY_KEY));
  } catch {
    return [];
  }
}

export function writePromptHistory(history: readonly string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PROMPT_HISTORY_KEY, JSON.stringify(history));
  } catch {
    // Storage disabled: history still works for this mount.
  }
}

/**
 * Index walk for ↑ / ↓. `null` means "not browsing".
 * Returns the next index and whether the original draft should be restored.
 */
export function stepHistory(
  index: number | null,
  direction: "older" | "newer",
  length: number,
): { index: number | null; restoreDraft: boolean } {
  if (length === 0) return { index: null, restoreDraft: index !== null };
  if (direction === "older") {
    if (index === null) return { index: 0, restoreDraft: false };
    return { index: Math.min(index + 1, length - 1), restoreDraft: false };
  }
  if (index === null) return { index: null, restoreDraft: false };
  if (index <= 0) return { index: null, restoreDraft: true };
  return { index: index - 1, restoreDraft: false };
}
