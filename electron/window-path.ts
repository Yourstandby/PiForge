/**
 * Normalizes a renderer-requested app path for a new window.
 * Only same-origin absolute paths are allowed so a compromised renderer cannot
 * navigate a fresh Electron window to an arbitrary origin.
 */
export function normalizeWindowPath(value: unknown): string {
  if (typeof value !== "string") return "/";
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  if (value.includes("://")) return "/";
  return value;
}
