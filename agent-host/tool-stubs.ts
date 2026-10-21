/**
 * 动态工具存根（第四维度）。
 *
 * 工具定义是上下文里最"贵且重复"的东西：一个 MCP 工具的 JSON Schema 常有
 * 300–1500 tokens，30 个工具就是上万 tokens —— 而且每一轮都要重新付一遍缓存读。
 * 但模型在真正需要某个工具之前，根本不需要它的完整 schema，它只需要知道
 * 「有这么个工具、它大概做什么」。
 *
 * 于是：扩展工具超过阈值时，声明里只保留核心工具；系统提示词里给一份
 * **存根目录**（名字 + 一句话简介）。模型通过 `tool_search`（或直接调用）
 * 点名某个工具后，下一轮才把它完整注入 —— 这正好也是唯一值得打破
 * 前缀缓存的「实质性变化」。
 */

/** 超过这个数量的扩展工具就只发存根（核心工具不计入）。 */
export const TOOL_STUB_THRESHOLD = 5;

/**
 * 我们自己提供的「点名加载」通道。
 *
 * `tool_search` 只能检索/激活 `deferred` / `codemode` 暴露级别的工具；
 * MCP 直曝（direct）与插件工具它拉不回来 —— 那就没路可走了。
 * 所以留一个极小的工具：传个名字，`setActiveTools` 把它加进去，
 * 下一轮它就会以完整 schema 出现。
 */
export const TOOL_USE_TOOL_NAME = "desktop_use_tool";

/** 单条存根简介的字数上限：超出就截断，保证目录整体够小。 */
export const STUB_DESCRIPTION_MAX = 48;

/** 整份存根目录的字符预算（≈ 900 tokens），超出的工具不进目录。 */
export const STUB_CATALOG_MAX_CHARS = 3600;

export interface ToolStubSource {
  name: string;
  description?: string;
}

export interface ToolStub {
  name: string;
  /** 一句话简介（已压掉换行与多余空白）。 */
  summary: string;
}

/** 一句话简介：抹平换行 / 多余空白，压到 STUB_DESCRIPTION_MAX 以内。 */
export function stubSummary(description: string | undefined): string {
  const text = (description ?? "")
    // 先抹平换行 / 多余空白并去掉首尾，否则 `^` 锚点会被前导空格卡住
    .replace(/\s+/g, " ")
    .trim()
    // MCP 描述常带 "Use this tool to …" 之类的模板前缀，削掉不影响语义
    .replace(/^(?:use this (?:tool )?(?:to|when)\s+)/i, "")
    .trim();
  if (!text) return "";
  const chars = Array.from(text);
  return chars.length <= STUB_DESCRIPTION_MAX
    ? text
    : `${chars.slice(0, STUB_DESCRIPTION_MAX).join("").trimEnd()}…`;
}

/** 需要走存根的扩展工具数量是否达标。 */
export function shouldUseToolStubs(extensionToolCount: number): boolean {
  return extensionToolCount > TOOL_STUB_THRESHOLD;
}

/**
 * 构建存根目录。
 * - 按工具名字典序（与工具声明同一套排序，前缀稳定）；
 * - 整份目录超出预算就截断尾部，并在末尾写明还有多少没列出。
 */
export function buildToolStubs(
  tools: readonly ToolStubSource[],
  maxChars: number = STUB_CATALOG_MAX_CHARS,
): { stubs: ToolStub[]; omitted: number } {
  const sorted = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const stubs: ToolStub[] = [];
  let used = 0;
  for (const tool of sorted) {
    const summary = stubSummary(tool.description);
    const line = `- ${tool.name}${summary ? `: ${summary}` : ""}`;
    if (used + line.length + 1 > maxChars) break;
    stubs.push({ name: tool.name, summary });
    used += line.length + 1;
  }
  return { stubs, omitted: sorted.length - stubs.length };
}

/**
 * 系统提示词里的存根目录。
 *
 * 这段话是**静态**的（同一份已注册工具集合永远渲染成同一串），
 * 所以它和前缀缓存相容：只会因为"工具真的增删"而变化。
 */
export function toolStubPromptSection(
  catalog: { stubs: ToolStub[]; omitted: number },
): string {
  if (catalog.stubs.length === 0) return "";
  const lines = catalog.stubs.map((stub) =>
    stub.summary ? `- ${stub.name}: ${stub.summary}` : `- ${stub.name}`,
  );
  if (catalog.omitted > 0) lines.push(`- …… 还有 ${catalog.omitted} 个工具未列出，请用 tool_search 检索`);
  return [
    "[未加载的工具]",
    "下面这些工具当前**没有**加载完整定义（省上下文）。需要用的时候：",
    `- 可检索的（MCP / 延迟加载）用 \`tool_search\` 检索并激活；`,
    `- 其它工具直接调 \`${TOOL_USE_TOOL_NAME}({ name })\` 点名，下一轮会注入完整定义。`,
    "不要臆测参数：没加载就先加载，别硬编造调用。",
    ...lines,
  ].join("\n");
}

/**
 * 计算这一轮到底声明哪些工具：
 * - 核心工具永远声明；
 * - 常驻工具（`tool_search` / `desktop_use_tool` / `spawn_agent`）永远声明：
 *   前两个是存根的激活通道（不声明就是死路），spawn_agent 是唯一的并行化原语
 *   （藏起来等于把「派子 Agent」这个能力关掉，模型只能串行跑 bash）；
 * - 扩展工具只有在「被点名」或「真的用过」时才完整声明；
 * - 其余扩展工具改用存根目录。
 */
export function selectDeclaredTools(input: {
  coreTools: readonly string[];
  /** 可声明的扩展工具（已按可用性筛过，不含激活通道）。 */
  extensionTools: readonly string[];
  /** SDK 侧已激活的扩展工具（tool_search 的结果）。 */
  activeExtensionTools: readonly string[];
  /** 近期真的调用过的扩展工具 / 被点名过的工具。 */
  usedExtensionTools: readonly string[];
  /** 常驻工具名：激活通道 + 并行化原语，永远声明。 */
  pinnedTools: readonly string[];
}): {
  declared: string[];
  stubbed: string[];
  /** 是否启用了存根模式（为 false 时扩展工具全量声明）。 */
  stubsActive: boolean;
} {
  const { coreTools, extensionTools, activeExtensionTools, usedExtensionTools } = input;
  const pinnedTools = [...input.pinnedTools];
  const extensionSet = new Set(extensionTools);
  const requested = [...new Set([...activeExtensionTools, ...usedExtensionTools])]
    .filter((name) => extensionSet.has(name))
    .sort();
  // 没有激活通道就不能存根：那些工具模型永远拿不回来。
  const canStub = pinnedTools.length > 0 && shouldUseToolStubs(extensionTools.length);

  if (!canStub) {
    // 工具不多（或没有激活通道）：全量声明，行为与以前一致。
    return {
      declared: [...new Set([...coreTools, ...extensionTools])].filter(Boolean),
      stubbed: [],
      stubsActive: false,
    };
  }

  const declared = [...new Set([...coreTools, ...requested, ...pinnedTools])];
  const stubbed = extensionTools.filter((name) => !declared.includes(name)).sort();
  return { declared, stubbed, stubsActive: true };
}
