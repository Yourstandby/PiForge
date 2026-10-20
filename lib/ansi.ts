/**
 * Minimal ANSI SGR → styled-span renderer for the terminal panel.
 *
 * xterm.js would be the "real" answer, but it is a heavy dependency for a
 * read-only log view; the panel only needs colors/attributes on already
 * complete lines. Unsupported sequences (cursor movement, cursor addressing,
 * OSC titles, device control) are dropped so log text stays readable.
 */

export interface AnsiSpan {
  text: string;
  /** CSS color for the foreground. */
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

/** 16-color palette tuned for a light background (ANSI order 30-37, 90-97). */
const ANSI_16: readonly string[] = [
  "#1f2937", // black
  "#c02a2a", // red
  "#15803d", // green
  "#a16207", // yellow
  "#1d4ed8", // blue
  "#7e22ce", // magenta
  "#0e7490", // cyan
  "#6b7280", // white
  "#4b5563", // bright black
  "#dc2626", // bright red
  "#16a34a", // bright green
  "#ca8a04", // bright yellow
  "#2563eb", // bright blue
  "#9333ea", // bright magenta
  "#0891b2", // bright cyan
  "#374151", // bright white
];

const ESC = "\u001b";

/** 256-color palette entry → CSS color. */
function color256(index: number): string {
  if (index < 0) return ANSI_16[0];
  if (index < 16) return ANSI_16[index];
  if (index >= 232) {
    const level = 8 + (Math.min(index, 255) - 232) * 10;
    return `rgb(${level}, ${level}, ${level})`;
  }
  const n = index - 16;
  const steps = [0, 95, 135, 175, 215, 255];
  const r = steps[Math.floor(n / 36) % 6];
  const g = steps[Math.floor(n / 6) % 6];
  const b = steps[n % 6];
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * Drop OSC sequences (titles, hyperlinks) and CR-overwrite artifacts, which
 * otherwise show up as garbage in a log view.
 */
export function normalizeTerminalText(input: string): string {
  let text = input.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "");
  // Progress bars rewrite a line with \r; only the final state matters.
  text = text.replace(/\r+\n/g, "\n");
  text = text
    .split("\n")
    .map((line) => {
      const last = line.lastIndexOf("\r");
      if (last === -1) return line;
      // A trailing CR is just a line ending; text before a mid-line CR is
      // overwritten.
      return last === line.length - 1 ? line.slice(0, last) : line.slice(last + 1);
    })
    .join("\n");
  return text;
}

/** Remove every escape sequence (for plain-text fallbacks / measurement). */
export function stripAnsi(input: string): string {
  return normalizeTerminalText(input).replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

interface StyleState {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

function applySgr(state: StyleState, params: number[]): void {
  for (let i = 0; i < params.length; i += 1) {
    const code = params[i];
    if (code === 0) {
      delete state.fg;
      delete state.bg;
      delete state.bold;
      delete state.dim;
      delete state.italic;
      delete state.underline;
    } else if (code === 1) state.bold = true;
    else if (code === 2) state.dim = true;
    else if (code === 3) state.italic = true;
    else if (code === 4) state.underline = true;
    else if (code === 22) {
      delete state.bold;
      delete state.dim;
    } else if (code === 23) delete state.italic;
    else if (code === 24) delete state.underline;
    else if (code >= 30 && code <= 37) state.fg = ANSI_16[code - 30];
    else if (code === 39) delete state.fg;
    else if (code >= 40 && code <= 47) state.bg = ANSI_16[code - 40];
    else if (code === 49) delete state.bg;
    else if (code >= 90 && code <= 97) state.fg = ANSI_16[code - 90 + 8];
    else if (code >= 100 && code <= 107) state.bg = ANSI_16[code - 100 + 8];
    else if (code === 38 || code === 48) {
      const target = code === 38 ? "fg" : "bg";
      if (params[i + 1] === 5) {
        state[target] = color256(params[i + 2] ?? 0);
        i += 2;
      } else if (params[i + 1] === 2) {
        state[target] = `rgb(${params[i + 2] ?? 0}, ${params[i + 3] ?? 0}, ${params[i + 4] ?? 0})`;
        i += 4;
      } else {
        i += 1;
      }
    }
  }
}

/** Split text into styled spans. Newlines are preserved inside the spans. */
export function parseAnsi(input: string): AnsiSpan[] {
  const text = normalizeTerminalText(input);
  const spans: AnsiSpan[] = [];
  const state: StyleState = {};
  let index = 0;

  const pushText = (value: string) => {
    if (!value) return;
    const span: AnsiSpan = { text: value };
    if (state.fg) span.fg = state.fg;
    if (state.bg) span.bg = state.bg;
    if (state.bold) span.bold = true;
    if (state.dim) span.dim = true;
    if (state.italic) span.italic = true;
    if (state.underline) span.underline = true;
    spans.push(span);
  };

  while (index < text.length) {
    const esc = text.indexOf(ESC, index);
    if (esc === -1) {
      pushText(text.slice(index));
      break;
    }
    if (esc > index) pushText(text.slice(index, esc));

    // CSI: ESC [ params final-byte
    if (text[esc + 1] === "[") {
      const match = /^\u001b\[([0-9;?]*)([ -/]*)([@-~])/.exec(text.slice(esc));
      if (!match) {
        index = esc + 1;
        continue;
      }
      const [raw, params, intermediates, final] = match;
      if (final === "m" && !intermediates) {
        const codes = params.replace(/\?/g, "").split(";").map((value) => (value === "" ? 0 : Number(value)));
        applySgr(state, codes);
      }
      index = esc + raw.length;
      continue;
    }

    // Other two-byte escapes (ESC ( B, ESC =, ...) are dropped.
    index = esc + 2;
  }

  return spans;
}
