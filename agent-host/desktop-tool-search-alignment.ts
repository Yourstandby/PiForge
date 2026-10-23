/**
 * tool_search 结果与「模型实际能调用的 wire name」对齐（第 8 步）。
 *
 * 踩过的坑：`tool_search` 会把注册表里所有 deferred 工具都当候选，包括我们为了合并
 * 而镜像注册的旧名字（`run_bg` / `browser_read` / `memory_*`…）。模型照着返回的
 * `- run_bg: …` 去调用，但声明层只发 wire name（`shell`），provider 直接回
 * "unsupported call"，模型于是重试或放弃 —— 这就是「命名改变导致失败」的根因。
 *
 * 修法（不改 SDK、不动 MCP 的 identity 判断，只在结果边界过滤）：
 *   1. 把本次 tool_search 激活的**旧名字**从 active 集合里撤掉（不声明它们）；
 *   2. 返回文本只列 wire name（与 `getActiveTools()` 暴露的名字逐字节一致）；
 *   3. 明确写出时序约束：新工具必须在**下一轮**调用，不要和 tool_search 同一条
 *      assistant response 里连调（那条请求的 schema 还是旧的）。
 *
 * 全量工具都还在注册表里、也还能被 `ctx.executeTool` 调用，只是不再冒充调用入口。
 */
import type { ExtensionAPI, ExtensionFactory, InlineExtension, ToolInfo } from "./sdk-adapter.ts";
import { DOMAIN_LEGACY_TOOLS } from "../lib/domain-tools.ts";
import { canonicalToolOrder } from "./prompt-prefix.ts";

/** tool_search 返回文本里必须带的时序约束。 */
export const TOOL_SEARCH_NEXT_TURN_CONSTRAINT =
  "Call the loaded tool(s) on your NEXT turn. A tool_search result is applied after this response, " +
  "so the new schema is not available for calls in the same response — do not chain tool_search and the loaded tool.";

export interface ToolSearchAlignmentResult {
  /** 过滤掉旧名字之后、真正可以调用的 wire name。 */
  wireNames: string[];
  /** 被过滤掉的内部注册名（只用于诊断，不回给模型）。 */
  droppedLegacyNames: string[];
  text: string;
}

/** 纯函数：把一次 tool_search 结果对齐成 wire name 文本（便于单测）。 */
export function alignToolSearchResult(input: {
  loaded: readonly string[];
  descriptions: Readonly<Record<string, string>>;
  isLegacy: (name: string) => boolean;
}): ToolSearchAlignmentResult {
  const wireNames: string[] = [];
  const droppedLegacyNames: string[] = [];
  for (const name of input.loaded) {
    if (input.isLegacy(name)) droppedLegacyNames.push(name);
    else if (!wireNames.includes(name)) wireNames.push(name);
  }

  if (wireNames.length === 0) {
    const text =
      droppedLegacyNames.length > 0
        ? `No loadable tool for that query. (${droppedLegacyNames.length} internal name(s) matched but are not callable directly; ` +
          "the merged tool that owns them is already available.)"
        : "No matching tools found.";
    return { wireNames, droppedLegacyNames, text };
  }

  const lines = wireNames.map(
    (name) => `- ${name}: ${(input.descriptions[name] ?? "").trim().split(/\r?\n/)[0]}`
  );
  const text = [
    `Loaded ${wireNames.length} tool${wireNames.length === 1 ? "" : "s"}. Use exactly these names:`,
    ...lines,
    TOOL_SEARCH_NEXT_TURN_CONSTRAINT,
  ].join("\n");
  return { wireNames, droppedLegacyNames, text };
}

export function createDesktopToolSearchAlignmentFactory(options: {
  enabled?: () => boolean;
  isLegacy?: (name: string) => boolean;
} = {}): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    const enabled = options.enabled ?? (() => true);
    const isLegacy = options.isLegacy ?? ((name: string) => DOMAIN_LEGACY_TOOLS.has(name));

    pi.on("tool_result", (event) => {
      if (event.toolName !== "tool_search" || event.isError) return;
      if (!enabled()) return;
      const details = (event.details ?? {}) as { loaded?: unknown };
      const loaded = Array.isArray(details.loaded)
        ? details.loaded.filter((name): name is string => typeof name === "string")
        : [];
      if (loaded.length === 0) return;

      const tools: ToolInfo[] = pi.getAllTools();
      const descriptions: Record<string, string> = {};
      for (const tool of tools) descriptions[tool.name] = tool.description ?? "";

      const aligned = alignToolSearchResult({ loaded, descriptions, isLegacy });
      if (process.env.PIFORGE_DEBUG_TOOLSEARCH === "1") {
        console.log("[tool-search] loaded:", loaded.join(","), "-> wire:", aligned.wireNames.join(","));
      }

      /**
       * 两件事必须一起做，否则「激活后前缀抖动」：
       *   1. 撤掉被激活的旧名字（它们不是调用入口，声明层也不会发它们）；
       *   2. **按 canonical 顺序重排 active**。SDK 的 tool_search 用
       *      `setActiveTools([...active, ...matches])` 把新工具追加在末尾，
       *      而我们的声明用 ASCII 字典序 —— 不重排的话，激活那一条请求是「追加序」，
       *      下一轮又变回「字典序」，同一集合两种字节序 = 两次缓存写入。
       */
      const active = pi.getActiveTools();
      const sorted = canonicalToolOrder(active.filter((name) => !isLegacy(name)));
      const orderChanged = sorted.length !== active.length || sorted.some((name, i) => name !== active[i]);
      if (orderChanged) {
        pi.setActiveTools(sorted);
        if (process.env.PIFORGE_DEBUG_TOOLSEARCH === "1") {
          console.log(
            "[tool-search] re-sorted active; dropped:",
            active.filter((name) => isLegacy(name)).join(",") || "(none)"
          );
        }
      }

      return {
        content: [{ type: "text" as const, text: aligned.text }],
        details: { loaded: aligned.wireNames, dropped: aligned.droppedLegacyNames },
      };
    });
  };
}

export function desktopToolSearchAlignmentInlineExtension(
  options: { enabled?: () => boolean; isLegacy?: (name: string) => boolean } = {}
): InlineExtension {
  return {
    name: "desktop-tool-search-alignment",
    factory: createDesktopToolSearchAlignmentFactory(options),
  };
}
