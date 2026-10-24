/**
 * 夜晚模式兜底映射表生成器（一次性工具，手工运行）。
 *
 * 历史组件把颜色写死成 `bg-[#ECECEF]` / `text-[#6B7280]` 这类字面量，暗色下需要
 * 按 class 名重定向到令牌。本脚本扫 `components/` + `app/` 里的字面量，按亮度/色相
 * 归类成目标令牌，输出 CSS 片段（tmp/dark-remap.css），由人工贴进
 * `app/globals.css` 的「浅色字面量 → 令牌映射」段。
 *
 * 注意：这是兜底，不是范式。新代码请直接用令牌（bg-bg-elevated / text-ink-muted …）。
 */
import fs from "node:fs";
import { execSync } from "node:child_process";

const raw = execSync(
  `rg -o --no-filename "\\b(?:bg|text|border|ring|divide|accent)-\\[#[0-9a-fA-F]{3,8}\\]" -g "*.tsx" components app`,
  { encoding: "utf8", maxBuffer: 1 << 26 },
);
const set = new Map(); // "prefix|hex" -> count
for (const m of raw.matchAll(/\b(bg|text|border|ring|divide|accent)-\[#([0-9a-fA-F]{3,8})\]/g)) {
  const key = `${m[1]}|${m[2].toLowerCase()}`;
  set.set(key, (set.get(key) ?? 0) + 1);
}

function hexToRgb(hex) {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length !== 6) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function toHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}
const lum = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

function pickBg(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return "--bg-subtle";
  const { h, s } = toHsl(rgb);
  const L = lum(rgb);
  const PAGE = new Set(["#fcfcfa", "#fafafa", "#fbfbf9", "#fafaf9", "#fbfcfa"]);
  if (PAGE.has(hex.toLowerCase())) return "--bg";
  if (L < 0.5) return null; // 深色背景多半是有意为之（深色按钮/遮罩），不动
  if (s > 0.45 && L < 0.75) return null; // 高饱和中等亮度：本身是强调色，留着
  if (L > 0.97) return s > 0.35 ? "--bg-selected" : "--bg-elevated";
  if (L > 0.93) return s > 0.35 ? "--bg-selected" : "--bg-subtle";
  if (s < 0.2) return L > 0.9 ? "--bg-hover" : "--bg-subtle";
  if (h >= 330 || h < 20) return "--danger-bg";
  if (h < 55) return "--warning-bg";
  if (h < 175) return "--success-bg";
  if (h < 265) return "--accent-soft";
  return "--bg-subtle";
}
function pickText(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return "--text";
  const { h, s } = toHsl(rgb);
  const L = lum(rgb);
  if (s > 0.28) {
    if (h >= 330 || h < 15) return "--danger";
    if (h < 45) return "--warning";
    if (h < 165) return "--success";
    if (h < 265) return "--accent";
    return "--text";
  }
  return L < 0.35 ? "--text" : L < 0.62 ? "--text-muted" : "--text-dim";
}
function pickBorder(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return "--border";
  const { h, s } = toHsl(rgb);
  if (lum(rgb) < 0.45) return null;
  if (s > 0.35) {
    if (h >= 330 || h < 15) return "--danger-border";
    if (h < 165) return "--success-border";
    if (h < 265) return "--accent-soft";
  }
  return "--border";
}

const groups = new Map(); // "prop|token" -> [selectors]
const push = (prop, token, sel) => {
  const key = `${prop}|${token}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(sel);
};

const stats = { bg: [0, 0], text: [0, 0], border: [0, 0] };
for (const [key, count] of set) {
  const [prefix, hex] = key.split("|");
  const sel = `:root[data-theme="dark"] [class*="${prefix}-[#${hex}]"],:root[data-theme="dark"] [class*="${prefix}-[#${hex.toUpperCase()}]"]`;
  if (prefix === "bg") {
    const token = pickBg(hex);
    if (!token) { stats.bg[1] += count; continue; }
    stats.bg[0] += count;
    push("background-color", token, sel);
  } else if (prefix === "text" || prefix === "accent") {
    stats.text[0] += count;
    push(prefix === "text" ? "color" : "accent-color", pickText(hex), sel);
  } else if (prefix === "border" || prefix === "divide" || prefix === "ring") {
    const token = pickBorder(hex);
    if (!token) { stats.border[1] += count; continue; }
    stats.border[0] += count;
    const prop = prefix === "border" ? "border-color" : prefix === "divide" ? "border-color" : "--tw-ring-color";
    push(prop, token, sel);
  }
}

let css = "";
for (const key of [...groups.keys()].sort()) {
  const [prop, token] = key.split("|");
  const sels = groups.get(key);
  css += `${sels.join(",\n")} {\n  ${prop}: var(${token});\n}\n`;
}
fs.writeFileSync("tmp/dark-remap.css", css);
console.log("已写出 tmp/dark-remap.css；把它贴进 app/globals.css 的字面量映射段（见该段注释）。");
console.log("bg covered/uncovered", stats.bg, "text", stats.text, "border", stats.border, "rules", groups.size);
