/**
 * pi 在图片被缩放后会往用户文本末尾追加一段坐标映射说明：
 * `[Image: original 2798x1800, displayed at 2000x1287. Multiply coordinates by 1.40 ...]`
 *
 * 这段文字只给模型看。两处需要把它当作“不存在”：
 * 1. 乐观消息与落盘消息的文本比对（否则带图消息匹配不上，界面出现重复气泡）；
 * 2. 用户气泡的渲染（否则同一句话里混进一大段机器注释）。
 */
const DIMENSION_NOTE_RE = /\[Image: original [^\]\n]*\]/g;

/** 去掉缩放说明并收敛空白；不改变用户的正常文字。 */
export function stripImageDimensionNotes(text: string): string {
  if (!text.includes("[Image: original ")) return text;
  return text
    .replace(DIMENSION_NOTE_RE, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 比对用的规范化文本：去说明 + 去首尾空白。 */
export function normalizeUserTextForMatch(text: string): string {
  return stripImageDimensionNotes(text).trim();
}
