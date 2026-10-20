/**
 * Unified-diff parser for the Git panel (diff text from `git diff`).
 *
 * Only what the viewer needs: per-row kind, old/new line numbers and text.
 * Rendering is plain divs — no Monaco, no diff library — so a 5k-line diff is
 * still just text nodes.
 */

export type DiffLineKind = "meta" | "hunk" | "add" | "del" | "context";

export interface DiffLine {
  kind: DiffLineKind;
  /** Line number in the old file (null for additions). */
  oldLine: number | null;
  /** Line number in the new file (null for deletions). */
  newLine: number | null;
  /** Raw content without the leading +/-/space marker. */
  text: string;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

const META_PREFIXES = [
  "diff --git ",
  "index ",
  "old mode ",
  "new mode ",
  "similarity index ",
  "dissimilarity index ",
  "rename from ",
  "rename to ",
  "copy from ",
  "copy to ",
  "new file mode ",
  "deleted file mode ",
  "Binary files ",
];

/** Parse `git diff` output into renderable rows with line numbers. */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  if (!diff.trim()) return [];
  const lines = diff.split(/\r?\n/);
  const rows: DiffLine[] = [];

  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  let sawHunk = false;

  for (const raw of lines) {
    const hunk = HUNK_RE.exec(raw);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      inHunk = true;
      sawHunk = true;
      rows.push({ kind: "hunk", oldLine: null, newLine: null, text: raw });
      continue;
    }

    // File headers only appear before the first hunk; after that, lines that
    // look like `---`/`+++` are real content ("-- x" removals).
    if (!inHunk && (raw.startsWith("--- ") || raw.startsWith("+++ ") || META_PREFIXES.some((prefix) => raw.startsWith(prefix)))) {
      rows.push({ kind: "meta", oldLine: null, newLine: null, text: raw });
      continue;
    }

    if (raw.startsWith("\\")) {
      // "\ No newline at end of file"
      rows.push({ kind: "meta", oldLine: null, newLine: null, text: raw });
      continue;
    }

    if (raw.startsWith("+")) {
      rows.push({ kind: "add", oldLine: null, newLine, text: raw.slice(1) });
      newLine += 1;
      continue;
    }
    if (raw.startsWith("-")) {
      rows.push({ kind: "del", oldLine, newLine: null, text: raw.slice(1) });
      oldLine += 1;
      continue;
    }

    if (!sawHunk) {
      // Preamble (commit message, "Changes not staged", ...) — show as meta.
      rows.push({ kind: "meta", oldLine: null, newLine: null, text: raw });
      continue;
    }

    // Context line: git prefixes it with a single space.
    const text = raw.startsWith(" ") ? raw.slice(1) : raw;
    rows.push({ kind: "context", oldLine, newLine, text });
    oldLine += 1;
    newLine += 1;
  }

  return rows;
}

/** Added/removed line counts, for the diff header badge. */
export function diffStats(rows: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.kind === "add") added += 1;
    else if (row.kind === "del") removed += 1;
  }
  return { added, removed };
}
