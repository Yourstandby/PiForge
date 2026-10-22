/**
 * 工具输出预算（第二维度：输出瘦身）。
 *
 * 上下文被撑爆几乎从来不是"模型话太多"，而是某次 `bash` / `read` 把几千行
 * 日志原封不动塞进了历史 —— 之后每轮请求都要为这段死文本付钱。
 * 这里定义一份**可测的硬上限**：超过就把中间替换成一句明确的截断说明，
 * 并告诉模型怎么继续读（grep / sed / offset / tool_history_get）。
 *
 * 两种策略：
 *   - head-tail（日志、命令输出）：头尾都留，中间省略 —— 报错常在尾部；
 *   - head-only（文件内容）：只留头部，尾部靠 offset 续读，且**保留 pi 自己的
 *     `[Use offset=... to continue.]` 分页提示**，否则模型不知道还能往后读。
 */

export interface ToolOutputBudget {
  /** 硬上限：行数（防止成千上万行短日志）。 */
  maxLines: number;
  /** 硬上限：字符数。**主预算**：4000 字符 ≈ 1000 tokens。 */
  maxChars: number;
  /** 保留头部字符数。 */
  headChars: number;
  /** 保留尾部字符数（head-only 策略为 0）。 */
  tailChars: number;
  /** 兼容旧调用：按字节判定的上限，保留字段不再作为主阈值。 */
  maxBytes: number;
  /** 保留头部行数（仅用于提示文案）。 */
  headLines: number;
  /** 保留尾部行数（仅用于提示文案）。 */
  tailLines: number;
  strategy: "head-tail" | "head-only";
}

/**
 * 默认预算：4000 字符（≈1000 tokens）+ 60 行兜底。
 * 超出后只留**前 1500 + 后 1500 字符**，中间用明确的截断说明代替。
 */
export const DEFAULT_TOOL_OUTPUT_BUDGET: ToolOutputBudget = {
  maxLines: 60,
  maxChars: 4_000,
  headChars: 1_500,
  tailChars: 1_500,
  maxBytes: 4_000,
  headLines: 40,
  tailLines: 40,
  strategy: "head-tail",
};

/**
 * `read` 是文件内容，需要**连续性**（模型会照着改代码），所以只留头部，
 * 行数放宽到 300 行；超出部分用 `offset` / `grep` 续读。
 */
export const READ_TOOL_OUTPUT_BUDGET: ToolOutputBudget = {
  maxLines: 120,
  maxChars: 4_000,
  // read 的重点是「从上往下能直接改代码」，所以头部配额更大；
  // 尾部保留一段用于看函数收尾，中间靠 offset / grep 续读。
  headChars: 3_000,
  tailChars: 1_000,
  maxBytes: 4_000,
  headLines: 300,
  tailLines: 0,
  strategy: "head-tail",
};

/** 文件内容型工具：按 `read` 的预算裁剪。 */
const FILE_CONTENT_TOOLS = new Set(["read"]);

export function toolOutputBudget(toolName: string | undefined): ToolOutputBudget {
  return toolName && FILE_CONTENT_TOOLS.has(toolName)
    ? READ_TOOL_OUTPUT_BUDGET
    : DEFAULT_TOOL_OUTPUT_BUDGET;
}

/** pi 自己给的分页提示，截断时必须原样保留在末尾。 */
const PAGINATION_HINT = /^\[.*(?:Use offset=|more lines in file).*\]$/i;

/** 要求的统一截断说明：明确写出截断了多少行 / 多少字符。 */
export function truncationNotice(totalLines: number, budget: ToolOutputBudget, omittedChars = 0): string {
  const kept =
    budget.strategy === "head-tail" && budget.tailChars > 0
      ? `已保留前 ${budget.headChars} 字符 + 后 ${budget.tailChars} 字符`
      : `已保留前 ${budget.headChars} 字符`;
  const omitted = omittedChars > 0 ? ` / ${omittedChars} 字符` : "";
  return `[...已截断 ${totalLines} 行${omitted}...]（${kept}）`;
}

/** 要求的续读引导。 */
export const TRUNCATION_HINT =
  '如需查看完整内容，请使用 grep、sed 等工具分段读取（例：grep -n "关键词" 文件 | sed -n \'1,120p\'）。';

export interface ToolOutputTruncation {
  /** 交给模型的文本（未截断时与入参完全一致）。 */
  text: string;
  truncated: boolean;
  totalLines: number;
  /** 实际保留的内容行数（不含说明行）。 */
  keptLines: number;
  /** 是否命中行数上限（否则是字节上限）。 */
  truncatedBy: "lines" | "chars" | null;
}

export function countTextLines(text: string): number {
  if (!text) return 0;
  const newlines = (text.match(/\n/g) ?? []).length;
  return text.endsWith("\n") ? newlines : newlines + 1;
}

export function exceedsToolOutputBudget(
  text: string,
  budget: ToolOutputBudget = DEFAULT_TOOL_OUTPUT_BUDGET,
): boolean {
  return text.length > budget.maxChars || countTextLines(text) > budget.maxLines;
}

/**
 * 按预算裁剪。幂等：对已经裁剪过的文本再调一次不会叠加说明块。
 */
export function truncateToolOutput(
  text: string,
  budget: ToolOutputBudget = DEFAULT_TOOL_OUTPUT_BUDGET,
): ToolOutputTruncation {
  const totalLines = countTextLines(text);
  if (text.length <= budget.maxChars && totalLines <= budget.maxLines) {
    return {
      text,
      truncated: false,
      totalLines,
      keptLines: totalLines,
      truncatedBy: null,
    };
  }
  const truncatedBy: "lines" | "chars" = text.length > budget.maxChars ? "chars" : "lines";

  const all = text.split(/\r?\n/);
  // 末尾换行会 split 出一个空串，别把它当内容行。
  if (all.length > 1 && all[all.length - 1] === "") all.pop();

  /** pi 的分页提示必须活到最后，否则模型失去"继续读"的入口。 */
  let paginationHint: string | null = null;
  for (let index = all.length - 1; index >= Math.max(0, all.length - 3); index -= 1) {
    const line = all[index]?.trim() ?? "";
    if (PAGINATION_HINT.test(line)) {
      paginationHint = line;
      all.splice(index, 1);
      break;
    }
  }

  const body = all.join("\n");
  const headChars = Math.max(0, budget.headChars);
  const tailChars = budget.strategy === "head-tail" ? Math.max(0, budget.tailChars) : 0;
  const omittedChars = Math.max(0, body.length - headChars - tailChars);

  // 说明块固定占位，正文按剩余额度取；单行超长（一行 40KB 的 JSON）也不会把说明切没。
  const notice = `${truncationNotice(totalLines, budget, omittedChars)}\n${TRUNCATION_HINT}`;
  const headText = lineAlignedSlice(body, 0, headChars);
  const tailText = tailChars > 0 ? lineAlignedSlice(body, Math.max(0, body.length - tailChars), body.length) : "";

  const blocks: string[] = [headText, notice];
  if (paginationHint) blocks.push(paginationHint);
  if (tailText) blocks.push(tailText);
  const composed = blocks.filter((block) => block.length > 0).join("\n\n");

  return {
    text: composed,
    truncated: true,
    totalLines,
    keptLines: countTextLines(headText) + (tailText ? countTextLines(tailText) : 0),
    truncatedBy,
  };
}

/** 按字符窗口取子串，并向行边界回退（避免把一行代码切两半）。 */
function lineAlignedSlice(text: string, start: number, end: number): string {
  if (start <= 0 && end >= text.length) return text;
  let from = Math.min(start, text.length);
  if (from > 0) {
    const newline = text.indexOf("\n", from);
    if (newline >= 0) from = newline + 1;
  }
  let to = Math.min(end, text.length);
  if (to < text.length) {
    const newline = text.lastIndexOf("\n", to);
    if (newline > from) to = newline;
  }
  return text.slice(from, Math.max(from, to));
}

/** 供 `tool-outputs.ts` 复用：判断是否需要走"落盘 + 预览"路径。 */
export function shouldTrimToolOutput(
  text: string,
  budget: ToolOutputBudget = DEFAULT_TOOL_OUTPUT_BUDGET,
): boolean {
  return exceedsToolOutputBudget(text, budget);
}
