/**
 * PiForge syntax themes — one per app theme.
 *
 * Palettes follow docs/ui-design-spec.md §3.4: keyword / function / string /
 * literal / comment / punctuation / deleted are the only seven anchors, and the
 * code surface always sits one step *below* the panel it lives on. Structure
 * mirrors the upstream Ayu theme this replaced (same token keys, same font and
 * line-height base) so react-syntax-highlighter needs no other change.
 */

type Theme = "light" | "dark" | "glacier";

const base = {
  'code[class*="language-"]': {
    fontFamily: "var(--font-mono)",
    fontSize: "1em",
    lineHeight: "1.6",
    textAlign: "left",
    whiteSpace: "pre",
    wordSpacing: "normal",
    wordBreak: "normal",
    wordWrap: "normal",
    tabSize: 2,
    hyphens: "none",
  },
  'pre[class*="language-"]': {
    fontFamily: "var(--font-mono)",
    fontSize: "1em",
    lineHeight: "1.6",
    textAlign: "left",
    whiteSpace: "pre",
    wordSpacing: "normal",
    wordBreak: "normal",
    wordWrap: "normal",
    tabSize: 2,
    hyphens: "none",
    margin: 0,
    overflow: "auto",
  },
} as const;

/** Graphite (html.dark) — neutral canvas, indigo-blue syntax. */
export const piforgeDarkSyntaxTheme = {
  ...base,
  'code[class*="language-"]': {
    ...base['code[class*="language-"]'],
    color: "#c7ccd3",
    background: "#0a0c0f",
  },
  'pre[class*="language-"]': {
    ...base['pre[class*="language-"]'],
    color: "#c7ccd3",
    background: "#0a0c0f",
  },
  'code[class*="language-"]::selection': { background: "rgba(140, 158, 255, 0.18)" },
  'pre[class*="language-"]::selection': { background: "rgba(140, 158, 255, 0.18)" },
  comment: { color: "#5f7fa6", fontStyle: "italic" },
  prolog: { color: "#5f7fa6" },
  doctype: { color: "#5f7fa6" },
  cdata: { color: "#5f7fa6" },
  punctuation: { color: "#8fa3bf" },
  operator: { color: "#8fa3bf" },
  entity: { color: "#8fa3bf" },
  property: { color: "#9fd0ff" },
  tag: { color: "#93a8ff" },
  boolean: { color: "#b9a7ff" },
  number: { color: "#b9a7ff" },
  constant: { color: "#b9a7ff" },
  symbol: { color: "#b9a7ff" },
  selector: { color: "#7ee0b0" },
  "attr-name": { color: "#9fd0ff" },
  string: { color: "#7ee0b0" },
  char: { color: "#7ee0b0" },
  builtin: { color: "#7ee0b0" },
  inserted: { color: "#7ee0b0" },
  url: { color: "#a5b8ff" },
  variable: { color: "#c7ccd3" },
  atrule: { color: "#9fd0ff" },
  "attr-value": { color: "#7ee0b0" },
  keyword: { color: "#93a8ff" },
  function: { color: "#9fd0ff" },
  "class-name": { color: "#9fd0ff" },
  regex: { color: "#a5b8ff" },
  important: { color: "#93a8ff", fontWeight: "600" },
  deleted: { color: "#ff9d9d" },
} as const;

/** Haze (glacier) — every anchor carries the ice tint. */
export const piforgeGlacierSyntaxTheme = {
  ...base,
  'code[class*="language-"]': {
    ...base['code[class*="language-"]'],
    color: "#d3e6f2",
    background: "#101e28",
  },
  'pre[class*="language-"]': {
    ...base['pre[class*="language-"]'],
    color: "#d3e6f2",
    background: "#101e28",
  },
  'code[class*="language-"]::selection': { background: "rgba(111, 215, 255, 0.18)" },
  'pre[class*="language-"]::selection': { background: "rgba(111, 215, 255, 0.18)" },
  comment: { color: "#6c8fa6", fontStyle: "italic" },
  prolog: { color: "#6c8fa6" },
  doctype: { color: "#6c8fa6" },
  cdata: { color: "#6c8fa6" },
  punctuation: { color: "#8eafc4" },
  operator: { color: "#8eafc4" },
  entity: { color: "#8eafc4" },
  property: { color: "#a9e4ff" },
  tag: { color: "#9ccfff" },
  boolean: { color: "#c0b4ff" },
  number: { color: "#c0b4ff" },
  constant: { color: "#c0b4ff" },
  symbol: { color: "#c0b4ff" },
  selector: { color: "#82e4c0" },
  "attr-name": { color: "#a9e4ff" },
  string: { color: "#82e4c0" },
  char: { color: "#82e4c0" },
  builtin: { color: "#82e4c0" },
  inserted: { color: "#82e4c0" },
  url: { color: "#9ccfff" },
  variable: { color: "#d3e6f2" },
  atrule: { color: "#a9e4ff" },
  "attr-value": { color: "#82e4c0" },
  keyword: { color: "#9ccfff" },
  function: { color: "#a9e4ff" },
  "class-name": { color: "#a9e4ff" },
  regex: { color: "#9ccfff" },
  important: { color: "#9ccfff", fontWeight: "600" },
  deleted: { color: "#ff9fa8" },
} as const;

/** Frost (light) — cool paper, cobalt syntax. */
export const piforgeLightSyntaxTheme = {
  ...base,
  'code[class*="language-"]': {
    ...base['code[class*="language-"]'],
    color: "#24303f",
    background: "#f5f8fc",
  },
  'pre[class*="language-"]': {
    ...base['pre[class*="language-"]'],
    color: "#24303f",
    background: "#f5f8fc",
  },
  'code[class*="language-"]::selection': { background: "rgba(43, 95, 217, 0.18)" },
  'pre[class*="language-"]::selection': { background: "rgba(43, 95, 217, 0.18)" },
  comment: { color: "#7a8a9c", fontStyle: "italic" },
  prolog: { color: "#7a8a9c" },
  doctype: { color: "#7a8a9c" },
  cdata: { color: "#7a8a9c" },
  punctuation: { color: "#57678a" },
  operator: { color: "#57678a" },
  entity: { color: "#57678a" },
  property: { color: "#2b62b8" },
  tag: { color: "#3450b8" },
  boolean: { color: "#6b4fc0" },
  number: { color: "#6b4fc0" },
  constant: { color: "#6b4fc0" },
  symbol: { color: "#6b4fc0" },
  selector: { color: "#1f7a50" },
  "attr-name": { color: "#2b62b8" },
  string: { color: "#1f7a50" },
  char: { color: "#1f7a50" },
  builtin: { color: "#1f7a50" },
  inserted: { color: "#1f7a50" },
  url: { color: "#1f63c7" },
  variable: { color: "#24303f" },
  atrule: { color: "#2b62b8" },
  "attr-value": { color: "#1f7a50" },
  keyword: { color: "#3450b8" },
  function: { color: "#2b62b8" },
  "class-name": { color: "#2b62b8" },
  regex: { color: "#1f63c7" },
  important: { color: "#3450b8", fontWeight: "600" },
  deleted: { color: "#b3352e" },
} as const;

export function syntaxThemeFor(theme: Theme) {
  if (theme === "glacier") return piforgeGlacierSyntaxTheme;
  return theme === "dark" ? piforgeDarkSyntaxTheme : piforgeLightSyntaxTheme;
}
