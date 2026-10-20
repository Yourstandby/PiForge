/**
 * Diff for an edit-style tool call, derived from the call's own arguments.
 *
 * pi does not persist tool result `details` (the `patch`/`diff` the edit tool
 * computes), so the before/after text in the *input* is the only reliable
 * source in the transcript:
 *   - `edit`  → { path, oldText, newText }
 *   - `write` → { path, content } (whole-file write, shown as additions)
 *
 * MCP tools that happen to name their fields the same way are picked up too,
 * which is why the lookup is field-based rather than name-only.
 */
import { diffLines, type DiffLine } from "./diff-lines.ts";

const EDIT_TOOL_NAMES = ["edit", "edit_file", "str_replace", "multi_edit", "apply_patch"];
const WRITE_TOOL_NAMES = ["write", "write_file", "create_file"];

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** True when this tool call is known to modify file content. */
export function isEditToolName(name: string): boolean {
  return EDIT_TOOL_NAMES.includes(name) || WRITE_TOOL_NAMES.includes(name);
}

interface ReplacePair {
  before: string;
  after: string;
}

/** pi's `edit` takes `edits: [{ oldText, newText }]`; older/MCP shapes are flat. */
function replacePairs(input: Record<string, unknown>): ReplacePair[] | null {
  const singleBefore = str(input.oldText) ?? str(input.old_string) ?? str(input.oldTextContent);
  const singleAfter = str(input.newText) ?? str(input.new_string) ?? str(input.newTextContent);
  if (singleBefore !== null && singleAfter !== null) {
    return [{ before: singleBefore, after: singleAfter }];
  }

  if (Array.isArray(input.edits)) {
    const pairs: ReplacePair[] = [];
    for (const entry of input.edits) {
      if (!entry || typeof entry !== "object") continue;
      const edit = entry as Record<string, unknown>;
      const before = str(edit.oldText) ?? str(edit.old_string);
      const after = str(edit.newText) ?? str(edit.new_string);
      if (before === null || after === null) continue;
      pairs.push({ before, after });
    }
    return pairs.length > 0 ? pairs : null;
  }

  return null;
}

/** Rows for the tool card, or null when the call carries no usable text. */
export function toolDiffRows(
  name: string,
  input: Record<string, unknown> | undefined,
): DiffLine[] | null {
  if (!input) return null;

  if (EDIT_TOOL_NAMES.includes(name)) {
    const pairs = replacePairs(input);
    if (!pairs) return null;
    const rows: DiffLine[] = [];
    pairs.forEach((pair, index) => {
      if (pairs.length > 1) {
        rows.push({ kind: "hunk", oldLine: null, newLine: null, text: `@@ 第 ${index + 1} 处修改 @@` });
      }
      rows.push(...diffLines(pair.before, pair.after));
    });
    return rows;
  }

  if (WRITE_TOOL_NAMES.includes(name)) {
    const content = str(input.content) ?? str(input.text);
    if (content === null) return null;
    return diffLines("", content);
  }

  return null;
}

/** Target path of an edit/write call, for the card header. */
export function toolDiffPath(name: string, input: Record<string, unknown> | undefined): string | null {
  if (!input || !isEditToolName(name)) return null;
  return str(input.path) ?? str(input.file_path) ?? str(input.filePath);
}
