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
  /** 硬上限：行数。 */
  maxLines: number;
  /** 硬上限：字节数（UTF-8）。两者先到先截。 */
  maxBytes: number;
  /** 保留头部行数。 */
  headLines: number;
  /** 保留尾部行数（head-only 策略为 0）。 */
  tailLines: number;
  strategy: "head-tail" | "head-only";
}

/** 默认预算：100 行 / 8KB ≈ 2–3k tokens，够看清结论，不够淹没上下文。 */
export const DEFAULT_TOOL_OUTPUT_BUDGET: ToolOutputBudget = {
  maxLines: 100,
  maxBytes: 8 * 1024,
  headLines: 40,
  tailLines: 40,
  strategy: "head-tail",
};

/**
 * `read` 是文件内容，需要**连续性**（模型会照着改代码），所以只留头部，
 * 行数放宽到 300 行；超出部分用 `offset` / `grep` 续读。
 */
export const READ_TOOL_OUTPUT_BUDGET: ToolOutputBudget = {
  maxLines: 300,
  maxBytes: 16 * 1024,
  headLines: 300,
  tailLines: 0,
  strategy: "head-only",
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

/** 要求的统一截断说明。 */
export function truncationNotice(totalLines: number, budget: ToolOutputBudget): string {
  const kept =
    budget.strategy === "head-tail"
      ? `已保留前 ${budget.headLines} 行与后 ${budget.tailLines} 行`
      : `已保留前 ${budget.headLines} 行`;
  return `[输出过长已截断，共 ${totalLines} 行]（${kept}）`;
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
  truncatedBy: "lines" | "bytes" | null;
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
  return (
    Buffer.byteLength(text, "utf8") > budget.maxBytes || countTextLines(text) > budget.maxLines
  );
}

/**
 * 按预算裁剪。幂等：对已经裁剪过的文本再调一次不会叠加说明块。
 */
export function truncateToolOutput(
  text: string,
  budget: ToolOutputBudget = DEFAULT_TOOL_OUTPUT_BUDGET,
): ToolOutputTruncation {
  const totalLines = countTextLines(text);
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalLines <= budget.maxLines && totalBytes <= budget.maxBytes) {
    return {
      text,
      truncated: false,
      totalLines,
      keptLines: totalLines,
      truncatedBy: null,
    };
  }
  const truncatedBy: "lines" | "bytes" = totalLines > budget.maxLines ? "lines" : "bytes";

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

  const headLines = all.slice(0, Math.max(0, budget.headLines));
  const tailLines =
    budget.strategy === "head-tail" && budget.tailLines > 0
      ? all.slice(Math.max(headLines.length, all.length - budget.tailLines))
      : [];

  /**
   * 先给说明块留出字节，再按剩余额度裁正文。
   * 顺序很重要：单行超长（例如一行 40KB 的压缩 JSON）时，若先拼接再整体按字节截，
   * 被切掉的恰好是尾部的说明块 —— 模型只看到一坨没有解释的片段。
   */
  const notice = `${truncationNotice(totalLines, budget)}\n${TRUNCATION_HINT}`;
  const contentBudget = Math.max(256, budget.maxBytes - Buffer.byteLength(notice, "utf8") - 8);
  const tailShare = tailLines.length > 0 ? 0.4 : 0;
  const headText = clipByBytes(
    headLines.join("\n"),
    Math.max(128, Math.floor(contentBudget * (1 - tailShare))),
  );
  const tailText =
    tailLines.length > 0
      ? clipByBytes(tailLines.join("\n"), Math.max(128, Math.floor(contentBudget * tailShare)))
      : "";

  const blocks: string[] = [headText, notice];
  if (paginationHint) blocks.push(paginationHint);
  if (tailText) blocks.push(tailText);
  const composed = blocks.filter((block) => block.length > 0).join("\n\n");

  return {
    text: composed,
    truncated: true,
    totalLines,
    keptLines: headLines.length + tailLines.length,
    truncatedBy,
  };
}

/** 按 UTF-8 字节窗口裁剪，且不切坏多字节字符。 */
function clipByBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const buffer = Buffer.from(text, "utf8");
  let end = Math.max(0, maxBytes);
  // 回退到字符边界（UTF-8 续字节形如 10xxxxxx）。
  while (end > 0 && (buffer[end] & 0b1100_0000) === 0b1000_0000) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

/** 供 `tool-outputs.ts` 复用：判断是否需要走"落盘 + 预览"路径。 */
export function shouldTrimToolOutput(
  text: string,
  budget: ToolOutputBudget = DEFAULT_TOOL_OUTPUT_BUDGET,
): boolean {
  return exceedsToolOutputBudget(text, budget);
}
