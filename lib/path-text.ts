/** Small, dependency-free path string helpers shared by the host and Next. */

const WINDOWS_ABSOLUTE_RE = /^[a-zA-Z]:[\\/]/;

export function normalizeSlashes(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

export function isWindowsAbsolutePath(filePath: string): boolean {
  return WINDOWS_ABSOLUTE_RE.test(filePath) || filePath.startsWith("\\\\") || filePath.startsWith("//");
}
