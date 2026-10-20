import { normalizeFilePathSlashes } from "./file-paths.ts";

/**
 * Detect local file references in chat / Markdown text.
 *
 * Supported shapes:
 *   src/index.ts
 *   components/Workbench.tsx:42
 *   components/Workbench.tsx:42:7
 *   @src/index.ts
 *   `/abs/path/file.ts`
 *   markdown: [label](src/index.ts:42)
 *
 * Web URLs, mailto:, bare prose words and parent-directory escapes are ignored.
 */

export interface FileReference {
  /** Path as written in the text (without `@`, line or column suffix). */
  path: string;
  line?: number;
  column?: number;
}

export interface FileReferenceSegment {
  type: "text" | "file";
  value: string;
  start: number;
  end: number;
  reference?: FileReference;
}

const KNOWN_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "jsonl", "md", "mdx", "css", "scss",
  "sass", "less", "html", "htm", "vue", "svelte", "py", "pyi", "go", "rs", "java",
  "kt", "kts", "swift", "c", "cc", "cpp", "cxx", "h", "hpp", "cs", "rb", "php",
  "sql", "yml", "yaml", "toml", "ini", "cfg", "conf", "sh", "bash", "zsh", "ps1",
  "bat", "cmd", "txt", "log", "xml", "svg", "png", "jpg", "jpeg", "gif", "webp",
  "ico", "avif", "mp3", "wav", "ogg", "mp4", "webm", "pdf", "env", "lock", "gradle",
]);

const KNOWN_FILE_NAMES = new Set([
  "Dockerfile", "Makefile", "LICENSE", "NOTICE", "README", "CHANGELOG", "Procfile",
]);

const TOKEN_RE = /@?(?:[A-Za-z]:[\\/]|\/)?[A-Za-z0-9_.\-]+(?:[\\/][A-Za-z0-9_.\-]+)*\.[A-Za-z0-9]{1,12}(?::\d+(?::\d+)?)?/g;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function hasKnownExtension(filePath: string): boolean {
  const base = filePath.replace(/\\/g, "/").split("/").pop() ?? "";
  if (KNOWN_FILE_NAMES.has(base)) return true;
  const extension = base.toLowerCase().split(".").pop();
  return extension ? KNOWN_EXTENSIONS.has(extension) : false;
}

function hasParentSegment(filePath: string): boolean {
  return filePath
    .replace(/\\/g, "/")
    .split("/")
    .some((segment) => segment === "..");
}

/** Parse a single token; returns null when it is not a local file reference. */
export function parseFileReference(raw: string): FileReference | null {
  let token = raw.trim();
  if (!token) return null;
  if (token.startsWith("@")) token = token.slice(1);
  // Strip sentence punctuation that commonly follows a path.
  token = token.replace(/[),.;!?]+$/g, "");
  if (!token || /\s/.test(token)) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(token)) return null;
  if (/^(https?|mailto|tel|data):/i.test(token)) return null;
  if (token.startsWith("www.")) return null;

  const decoded = safeDecode(token);
  if (decoded.startsWith("/api/") || decoded.startsWith("/_next/")) return null;
  if (hasParentSegment(decoded)) return null;

  const match = /^(.*?):(\d+)(?::(\d+))?$/.exec(decoded);
  let filePath = decoded;
  let line: number | undefined;
  let column: number | undefined;
  if (match && match[1]) {
    filePath = match[1];
    line = Number(match[2]);
    column = match[3] ? Number(match[3]) : undefined;
  }

  if (!filePath || filePath.endsWith("/") || filePath.endsWith("\\")) return null;
  if (!hasKnownExtension(filePath)) return null;
  return {
    path: normalizeFilePathSlashes(filePath),
    ...(line !== undefined && Number.isFinite(line) ? { line } : {}),
    ...(column !== undefined && Number.isFinite(column) ? { column } : {}),
  };
}

/** Resolve a parsed reference to an absolute path for the file viewer. */
export function resolveFileReferencePath(
  reference: FileReference,
  cwd: string | null | undefined,
): string | null {
  let filePath = reference.path.replace(/\\/g, "/");
  if (/^file:\/\//i.test(filePath)) {
    filePath = safeDecode(filePath.replace(/^file:\/\//i, "").replace(/^\/([A-Za-z]:)/, "$1"));
  }
  if (/^[A-Za-z]:\//.test(filePath) || filePath.startsWith("//")) return filePath;
  if (!cwd) return filePath.startsWith("/") ? filePath : null;
  const root = normalizeFilePathSlashes(cwd).replace(/\/+$/, "");
  // On Windows a leading "/" in Markdown means project root, not drive root.
  if (filePath.startsWith("/")) {
    if (/^[A-Za-z]:\//.test(root)) return normalizeFilePathSlashes(`${root}${filePath}`);
    return filePath;
  }
  return normalizeFilePathSlashes(`${root}/${filePath.replace(/^\.?\//, "")}`);
}

/** Split arbitrary text into text / clickable file-reference segments. */
export function findFileReferences(text: string): FileReferenceSegment[] {
  const segments: FileReferenceSegment[] = [];
  const matcher = new RegExp(TOKEN_RE.source, "g");
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(text)) !== null) {
    const raw = match[0];
    const start = match.index;
    const before = start > 0 ? text[start - 1] : "";
    // Avoid matching the tail of a URL (`https://x/y.ts`) or a mid-word token.
    if (before && /[A-Za-z0-9_./\\-]/.test(before)) continue;

    const reference = parseFileReference(raw);
    if (!reference) continue;
    // Plain prose words only become links when they contain a path separator
    // or an explicit `@` prefix (e.g. `package.json` is still ambiguous).
    const hasSeparator = reference.path.includes("/") || reference.path.includes("\\");
    if (!hasSeparator && !raw.startsWith("@")) continue;

    if (start > lastIndex) {
      segments.push({ type: "text", value: text.slice(lastIndex, start), start: lastIndex, end: start });
    }
    segments.push({ type: "file", value: raw, start, end: start + raw.length, reference });
    lastIndex = start + raw.length;
  }

  if (lastIndex < text.length) {
    segments.push({ type: "text", value: text.slice(lastIndex), start: lastIndex, end: text.length });
  }
  return segments.length > 0 ? segments : [{ type: "text", value: text, start: 0, end: text.length }];
}

/** Resolve a Markdown link href to a local file reference (or null). */
export function resolveHrefFileReference(
  href: string | undefined,
  cwd: string | null | undefined,
): { path: string; line?: number; column?: number } | null {
  if (!href) return null;
  const clean = href.split("#", 1)[0].split("?", 1)[0].trim();
  if (!clean || clean.startsWith("#") || clean.startsWith("?")) return null;
  if (/^(https?|mailto|tel|data):/i.test(clean)) return null;

  let candidate = clean;
  if (/^file:\/\//i.test(candidate)) {
    candidate = safeDecode(candidate.replace(/^file:\/\//i, "")).replace(/^\/([A-Za-z]:)/, "$1");
  }
  const reference = parseFileReference(candidate);
  if (!reference) return null;
  const resolved = resolveFileReferencePath(reference, cwd);
  if (!resolved) return null;
  return { path: resolved, line: reference.line, column: reference.column };
}
