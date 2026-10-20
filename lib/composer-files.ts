/**
 * Helpers for files dropped / pasted into the composer.
 *
 * Images become attachments (base64 + thumbnail); everything else becomes an
 * `@path` reference in the prompt text. Pure functions so the string behavior
 * stays testable without a DOM.
 */

export const IMAGE_FILE_EXTENSIONS: readonly string[] = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "svg",
  "avif",
  "ico",
];

/** Mime type first (most reliable), extension as the fallback. */
export function isImageFileLike(name: string, mimeType: string | undefined): boolean {
  if (mimeType && mimeType.startsWith("image/")) return true;
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return IMAGE_FILE_EXTENSIONS.includes(ext);
}

/**
 * Append `@path` references to the composer text.
 *
 * - paths already referenced are skipped (no duplicates on repeated drops)
 * - a single separating space is added, and a trailing space leaves the caret
 *   ready for the next word
 */
export function buildReferenceInsertion(current: string, paths: readonly string[]): string {
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const raw of paths) {
    const path = raw.trim();
    if (!path) continue;
    if (current.includes(`@${path}`)) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    refs.push(`@${path}`);
  }
  if (refs.length === 0) return current;
  const separator = current.length === 0 || /\s$/.test(current) ? "" : " ";
  return `${current}${separator}${refs.join(" ")} `;
}
