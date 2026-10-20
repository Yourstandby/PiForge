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

/** Above this many DP cells the line diff degrades to a delete-block/add-block. */
const DIFF_CELL_LIMIT = 260_000;

interface DiffOp {
  kind: "context" | "add" | "del";
  text: string;
}

function splitDiffLines(text: string): string[] {
  if (!text) return [];
  // A single trailing newline is a file terminator, not an extra empty line.
  const normalized = text.replace(/\r\n/g, "\n").replace(/\n$/, "");
  return normalized.split("\n");
}

function lcsOps(oldLines: string[], newLines: string[]): DiffOp[] {
  const n = oldLines.length;
  const m = newLines.length;
  if (n === 0) return newLines.map((text) => ({ kind: "add", text }));
  if (m === 0) return oldLines.map((text) => ({ kind: "del", text }));
  if (n * m > DIFF_CELL_LIMIT) {
    return [
      ...oldLines.map((text): DiffOp => ({ kind: "del", text })),
      ...newLines.map((text): DiffOp => ({ kind: "add", text })),
    ];
  }

  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] =
        oldLines[i] === newLines[j]
          ? dp[(i + 1) * width + (j + 1)] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)]);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ kind: "context", text: oldLines[i] });
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
      ops.push({ kind: "del", text: oldLines[i] });
      i += 1;
    } else {
      ops.push({ kind: "add", text: newLines[j] });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ kind: "del", text: oldLines[i] });
    i += 1;
  }
  while (j < m) {
    ops.push({ kind: "add", text: newLines[j] });
    j += 1;
  }
  return ops;
}

/**
 * Line diff between two text fragments (no git involved), in the same row
 * shape as {@link parseUnifiedDiff} so both can use one renderer.
 *
 * Used by the transcript's tool cards: `edit` gives before/after snippets,
 * `write` an entire file. Common leading/trailing lines become context rows.
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const oldLines = splitDiffLines(oldText);
  const newLines = splitDiffLines(newText);

  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const ops: DiffOp[] = [
    ...oldLines.slice(0, prefix).map((text): DiffOp => ({ kind: "context", text })),
    ...lcsOps(oldLines.slice(prefix, oldLines.length - suffix), newLines.slice(prefix, newLines.length - suffix)),
    ...oldLines.slice(oldLines.length - suffix).map((text): DiffOp => ({ kind: "context", text })),
  ];

  const rows: DiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (const op of ops) {
    if (op.kind === "context") {
      rows.push({ kind: "context", oldLine, newLine, text: op.text });
      oldLine += 1;
      newLine += 1;
    } else if (op.kind === "add") {
      rows.push({ kind: "add", oldLine: null, newLine, text: op.text });
      newLine += 1;
    } else {
      rows.push({ kind: "del", oldLine, newLine: null, text: op.text });
      oldLine += 1;
    }
  }
  return rows;
}
