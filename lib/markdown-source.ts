/**
 * 聊天正文的 Markdown 预规范化。
 *
 * GFM 的「扩展裸链接」（autolink literal）会一路吃到空白为止：
 *   `**http://host/_x/**：` → 结尾的 `**：` 被吞进 URL，
 *   `**` 失去闭合伙伴，整段原样显示成 `**…**`；
 *   `见 http://host/api，然后继续` → 中文整段被吞进 href。
 *
 * 这里把这类裸 URL 收进 CommonMark 尖括号 autolink（`<url>`），
 * 让链接在 URL 处止步；代码块与行内代码原样保留。
 */

import { trimTrailingPunctuation } from "./file-links.ts";

/** 与 lib/file-links 同源的裸 URL 形状；额外排除 `*`，否则 `**url**` 的结束星号会被吞。 */
const BARE_URL_RE = /(?:https?:\/\/|www\.)[^\s<>"'\`，。、；：！？（）【】「」『』《》\\*]+/g;

/** 行内代码片段（含反引号本身），不参与改写。 */
const INLINE_CODE_RE = /(`+[^`]*`+)/;

/** 围栏代码块起始 / 结束。 */
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;

/** URL 后面紧跟非 ASCII（中文标点、汉字）时 GFM 会把它们吃进链接。 */
const NON_ASCII_START_RE = /^[^\x00-\x7F]/;

/** 紧贴 URL 的强调定界符（`**url**`、`__url__`）。 */
const EMPHASIS_CHAR_RE = /[*_]/;

function wrapBareUrls(segment: string): string {
  if (!segment.includes("://") && !segment.includes("www.")) return segment;
  return segment.replace(BARE_URL_RE, (match: string, offset: number, whole: string) => {
    // www. 开头的没有 scheme，包进 <...> 会退化成字面量文本，保持原样。
    if (!/^https?:\/\//i.test(match)) return match;
    const url = trimTrailingPunctuation(match);
    if (!url) return match;

    const before = whole.slice(0, offset);
    const prev = before.slice(-1);
    const next = whole.slice(offset + url.length, offset + url.length + 1);
    if (prev === "<" || prev === "(" || prev === "[") return match; // 已在 autolink / 链接里
    const gluedEmphasis = EMPHASIS_CHAR_RE.test(prev) || EMPHASIS_CHAR_RE.test(next);
    const swallowsCjk = NON_ASCII_START_RE.test(next);
    if (!gluedEmphasis && !swallowsCjk) return match;
    return `<${url}>`;
  });
}

/** 按行处理：fenced code 整段跳过，行内代码片段跳过。 */
export function normalizeMarkdownSource(source: string): string {
  if (!source || (!source.includes("://") && !source.includes("www."))) return source;

  const lines = source.split("\n");
  const out: string[] = [];
  let fence: string | null = null;

  for (const line of lines) {
    const fenceMatch = FENCE_RE.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) {
        fence = null;
      }
      out.push(line);
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      out.push(line);
      continue;
    }
    out.push(
      line
        .split(INLINE_CODE_RE)
        .map((part, index) => (index % 2 === 1 ? part : wrapBareUrls(part)))
        .join(""),
    );
  }

  return out.join("\n");
}
