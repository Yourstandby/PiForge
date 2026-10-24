/**
 * Inline pi extension: Ask-mode confirms for bash/write/edit.
 */
import type { ExtensionAPI, ExtensionFactory, InlineExtension } from "./sdk-adapter.ts";
import {
  askBlockResult,
  needsAskConfirm,
  summarizeToolCall,
  PLAN_MODE_SYSTEM_PROMPT,
  RESPONSE_LANGUAGE_PROMPT,
  type AgentMode,
  type ToolPreset,
  PLAN_TOOLS,
} from "../lib/approval-policy.ts";
import { desktopRuntimeTools, isMcpTool } from "./desktop-runtime-tools.ts";
import {
  STATIC_CWD_SECTION,
  buildPrefixSnapshot,
  canonicalToolOrder,
  diffPrefixSnapshots,
  emptyPrefixAudit,
  estimatePrefixTokens,
  isExpectedPrefixChange,
  recordPrefixChange,
  userContextBlock,
  type PrefixAudit,
  type PrefixSnapshot,
} from "./prompt-prefix.ts";
import {
  TOOL_USE_TOOL_NAME,
  buildToolStubs,
  selectDeclaredTools,
  toolStubPromptSection,
} from "./tool-stubs.ts";
import {
  DOMAIN_TOOL_NAMES,
  enabledOnDemandDomains,
  PLAN_READONLY_LEGACY_TOOLS,
  isPlanAllowedDomainCall,
} from "../lib/domain-tools.ts";
import { Type } from "typebox";

export type AgentModeRef = {
  current: AgentMode;
  toolPreset?: ToolPreset;
  codemodeEnabled?: boolean;
  /** 会话工作目录：只给用户消息用，不进 system prompt。 */
  getCwd?: () => string | undefined;
  /** 模型点名要用、但当前只发了存根的工具（下一轮完整声明）。 */
  requestedTools?: Set<string>;
  /**
   * 可关的提示词附加项（设置项控制，默认都开）。关掉只影响 system prompt 的
   * 静态段落，不改工具、不改上下文长度。
   */
  promptAddons?: { outputStyle?: boolean; responseLanguage?: boolean; collab?: boolean };
  /** 前缀棘轮审计（每轮 before_agent_start 更新，get_state 上报）。 */
  prefixAudit?: PrefixAudit;
};

/**
 * 前缀缓存友好：默认只带这几个"日常够用"的工具，把工具定义从 30+ 降到 ≤6。
 * 其余工具（MCP / 生图 / 决策 / 子 Agent / herdr / 插件 / tool_search / memory…）
 * 只在"上一轮真的用过"时才重新纳入，且最终列表按字母序固定下来，
 * 保证同一状态下序列化出来的工具数组字节级一致。
 */
const CORE_TOOLS = ["bash", "edit", "read", "write"];

/** 每条用户消息尾部携带的易变状态块（display:false，不进对话记录）。 */
function contextMessage(content: string) {
  return { customType: "desktop-context", content, display: false as const };
}

export function createDesktopApprovalFactory(modeRef: AgentModeRef): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    /** 最近实际调用过的工具（跨轮次保留）：用来决定是否放开扩展工具。 */
    const recentlyUsedTools = new Set<string>();
    /** 模型通过 `desktop_use_tool` 点名的工具（跨轮次保留）。 */
    const requestedTools = (modeRef.requestedTools ??= new Set<string>());

    /**
     * 存根的「点名加载」通道。
     * 只做两件事：校验工具存在 → 加进 active（下一轮本扩展会把它完整声明）。
     */
    pi.registerTool({
      name: TOOL_USE_TOOL_NAME,
      label: "Use Tool",
      description:
        "Load the full definition of a tool listed as a stub, so it can be called on the next turn.",
      promptSnippet: "Load a stubbed tool by name",
      promptGuidelines: [
        "When the needed tool is only listed as a stub, call desktop_use_tool with its exact name first, then call it on the next turn.",
      ],
      parameters: Type.Object({
        name: Type.String({ description: "Exact tool name from the stub list." }),
      }),
      defaultActive: true,
      async execute(_toolCallId, params) {
        const name = String(params.name ?? "").trim();
        const exists = pi.getAllTools().some((tool) => tool.name === name);
        if (!exists) {
          return {
            content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
            details: { ok: false, name },
          };
        }
        requestedTools.add(name);
        const active = pi.getActiveTools();
        // 工具列表始终保持字典序 + 去重：工具 schema 的序列化顺序必须稳定，
        // 否则每次动态加载工具都会把 prompt cache 前缀打散。
        if (!active.includes(name)) pi.setActiveTools(canonicalToolOrder([...active, name]));
        return {
          content: [
            {
              type: "text" as const,
              text: `Loaded ${name}. Its full definition is available from the next turn.`,
            },
          ],
          details: { ok: true, name },
        };
      },
    });
    /**
     * 工具装载锁定（前缀缓存）：
     * `getAllTools()` 的顺序会随 MCP 异步注册 / 重连而变，每次都重算就有机会
     * 排出不同顺序 → 工具数组字节变了，整条前缀缓存作废。
     * 这里把「决定装载的条件」做成 key：key 没变就**原样复用上一份数组**，
     * 不重算、不重排，保证同一状态下每次请求的工具声明字节级一致。
     */
    let latchedLoadout: { key: string; tools: string[] } | null = null;
    /**
     * 前缀审计：记录上一轮真正发出去的前缀各段内容。
     * 缓存被打破时能直接告诉你是哪一段在动，而不是只给一个哈希。
     *   PIFORGE_DEBUG_PREFIX=1 npm run dev:electron
     */
    let lastPrefix: PrefixSnapshot | null = null;

    pi.on("before_agent_start", (event) => {
      const preset = modeRef.toolPreset ?? "default";
      const registered = pi.getAllTools();
      const available = desktopRuntimeTools(
        modeRef.current,
        preset,
        modeRef.codemodeEnabled ?? false,
        registered,
        pi.getActiveTools(),
      );
      /**
       * 动态工具存根（第四维度）：
       * 扩展工具 > 5 个时不再全量声明，只给「名字 + 一句话」的目录；
       * 模型通过 `tool_search` 激活（active）或真的用过（used）某个工具后，
       * 下一轮才把它的完整 schema 注入 —— 这也是唯一值得翻新前缀的实质性变化。
       */
      const coreTools = available.filter((name) => CORE_TOOLS.includes(name));
      /**
       * 常驻工具：永远声明。
       * - `tool_search` / `desktop_use_tool`：存根的激活通道，不声明就是死路；
       * - `spawn_agent` / `herdr_spawn`：两个 Agent 派生原语。它们一被存根，模型就再也
       *   派不出子 Agent / 舰队（只能串行 bash），而「Agents 面板没反应」正是这个后果。
       */
      const pinnedTools = [
        ...(registered.some((tool) => tool.name === "tool_search") ? ["tool_search"] : []),
        ...(registered.some((tool) => tool.name === TOOL_USE_TOOL_NAME) ? [TOOL_USE_TOOL_NAME] : []),
        // 多态工具：没被开关点名的恒常驻；被点名的只在激活后常驻（否则模型刚拿到又失去）。
        ...DOMAIN_TOOL_NAMES.filter(
          (name) =>
            registered.some((tool) => tool.name === name) &&
            (!enabledOnDemandDomains().includes(name) || pi.getActiveTools().includes(name))
        ),
      ];
      const extensionTools = available.filter(
        (name) => !CORE_TOOLS.includes(name) && !pinnedTools.includes(name),
      );
      const activeExtensionTools = pi
        .getActiveTools()
        .filter((name) => extensionTools.includes(name));
      const usedExtensionTools = [...new Set([...recentlyUsedTools, ...requestedTools])].filter(
        (name) => extensionTools.includes(name),
      );
      const selection = selectDeclaredTools({
        coreTools,
        extensionTools,
        activeExtensionTools,
        usedExtensionTools,
        pinnedTools,
      });
      /** plan 模式 / 预设 none 保持原样（本身就是静态小集合）。 */
      const keepFullLoadout = preset === "none" || modeRef.current === "plan";

      /**
       * 装载 key：模式 / 预设 / codemode / 已注册工具集合 / 已激活工具集合 / 实际声明的工具集。
       * `active` 必须入 key：`tool_search` 会在 SDK 侧把 deferred 工具拉进 active，
       * 若锁存不感知，下一轮就会把它重新“摁回去”（模型刚拿到的工具凭空消失）。
       */
      const loadoutKey = [
        modeRef.current,
        preset,
        modeRef.codemodeEnabled ? "codemode" : "-",
        keepFullLoadout ? "full" : selection.stubsActive ? "stubs" : "flat",
        `declared:${canonicalToolOrder(selection.declared).join(",")}`,
        canonicalToolOrder(registered.map((tool) => tool.name)).join(","),
        `active:${canonicalToolOrder(pi.getActiveTools()).join(",")}`,
      ].join("|");

      let tools: string[];
      if (latchedLoadout && latchedLoadout.key === loadoutKey) {
        tools = latchedLoadout.tools;
      } else {
        // 字典序是**强制**的：同一份集合永远只对应一种序列化顺序。
        tools = canonicalToolOrder(keepFullLoadout ? available : selection.declared);
        latchedLoadout = { key: loadoutKey, tools };
      }
      pi.setActiveTools(tools);

      /** 存根目录（只列未声明的那批，静态文本 → 与缓存兼容）。 */
      const stubSection =
        !keepFullLoadout && selection.stubsActive
          ? toolStubPromptSection(
              buildToolStubs(
                registered
                  .filter((tool) => selection.stubbed.includes(tool.name))
                  .map((tool) => ({ name: tool.name, description: tool.description })),
              ),
            )
          : "";
      if (stubSection) {
        const current = event.systemPromptOptions.appendSystemPrompt;
        event.systemPromptOptions.appendSystemPrompt = current
          ? `${current}\n\n${stubSection}`
          : stubSection;
      }

      /**
       * 回复语言：pi 默认 prompt 不约束语言，模型常在工具调用之间用英文复述
       * 计划（"Now the grouping logic + panel:"），中文对话里看着很割裂。
       * 静态文本，不含任何易变状态 → 不破坏前缀缓存；设置项可关（默认开）。
       */
      /**
       * 位置实验开关（第 3 步度量用，默认关）：
       *   PIFORGE_LANGUAGE_IN_MESSAGE=1 → 这 104 tok 从 system prompt 挪到每条用户消息。
       * 实测结论见 docs/measurements/README.md：前缀短 104 tok，但每条用户消息都多背
       * 104 tok，总成本更高，所以默认仍留在前缀。
       */
      const languageInMessage = process.env.PIFORGE_LANGUAGE_IN_MESSAGE === "1";
      if (!languageInMessage && modeRef.promptAddons?.responseLanguage !== false) {
        const current = event.systemPromptOptions.appendSystemPrompt;
        event.systemPromptOptions.appendSystemPrompt = current
          ? `${current}\n\n${RESPONSE_LANGUAGE_PROMPT}`
          : RESPONSE_LANGUAGE_PROMPT;
      }

      /**
       * 状态剥离（开关式，默认关）：把 system prompt 里的 cwd 换成固定文本，
       * 真实 cwd 跟用户消息走。
       *
       * 为什么默认关：pi 把 cwd 渲染成 system prompt 的**最后一段**，而 PiForge
       * 的一个会话 = 一个项目目录，cwd 在会话期间不变 → 它已经是稳定前缀的一部分，
       * 搬走反而是每轮多付十几 token。只有当上层开始往 prompt 里塞真的会变的
       * 状态（分支名、时间、选中文件…）时，才建议打开：
       *   PIFORGE_PREFIX_STRIP_CWD=1
       */
      const stripCwd = process.env.PIFORGE_PREFIX_STRIP_CWD === "1";
      if (stripCwd) {
        const sections = event.systemPromptOptions.sections ?? {};
        if (sections.cwd !== STATIC_CWD_SECTION) {
          event.systemPromptOptions.sections = { ...sections, cwd: STATIC_CWD_SECTION };
        }
      }
      const contextBlock = stripCwd ? userContextBlock({ cwd: modeRef.getCwd?.() }) : null;
      // 实验：把回复语言约束放在用户消息侧（display:false，不进对话记录）。
      const messageBlock =
        languageInMessage && modeRef.promptAddons?.responseLanguage !== false
          ? [contextBlock, RESPONSE_LANGUAGE_PROMPT].filter(Boolean).join("\n\n")
          : contextBlock;

      /**
       * 前缀棘轮审计：同一会话里除「按需域首次激活」外，相邻两轮必须字节一致。
       * 不一致 → 整段历史缓存作废，所以这里既计数（get_state 里能看到）也告警。
       *   PIFORGE_DEBUG_PREFIX=1  打印每次变化的差异段
       */
      {
        const snapshot = buildPrefixSnapshot(event.systemPromptOptions, tools);
        const firstBuild = lastPrefix === null;
        const diff = diffPrefixSnapshots(lastPrefix, snapshot);
        lastPrefix = snapshot;
        // 首次建立前缀不算「变化」，之后只允许「按需域首次激活」这一种变化。
        const expected = firstBuild || isExpectedPrefixChange(diff, enabledOnDemandDomains());
        const audit = modeRef.prefixAudit ?? emptyPrefixAudit();
        modeRef.prefixAudit = firstBuild
          ? { ...audit, turns: audit.turns + 1, stableTurns: audit.stableTurns + 1 }
          : recordPrefixChange(audit, diff, expected);
        if (!diff.identical) {
          if (!expected) {
            console.warn("[prefix] UNEXPECTED change (cache invalidated)", {
              summary: diff.summary,
              toolsAdded: diff.toolsAdded,
              toolsRemoved: diff.toolsRemoved,
              sectionsChanged: diff.sectionsChanged,
              toolsReordered: diff.toolsReordered,
            });
          } else if (process.env.PIFORGE_DEBUG_PREFIX === "1") {
            console.log("[prefix] expected on-demand activation", {
              added: diff.toolsAdded,
              approxTokens: estimatePrefixTokens(snapshot),
            });
          }
        }
      }

      if (modeRef.current === "plan") {
        // Appending to the options (instead of forcing a prompt) keeps pi's own
        // section rendering and the current tool loadout intact. Plan tools are
        // read-only already; this text tells the model what to deliver.
        const appended = event.systemPromptOptions.appendSystemPrompt;
        event.systemPromptOptions.appendSystemPrompt = appended
          ? `${appended}\n\n${PLAN_MODE_SYSTEM_PROMPT}`
          : PLAN_MODE_SYSTEM_PROMPT;
        return messageBlock ? { message: contextMessage(messageBlock) } : undefined;
      }
      if (preset === "none") return { systemPrompt: "" };
      return messageBlock ? { message: contextMessage(messageBlock) } : undefined;
    });
    pi.on("tool_call", async (event, ctx) => {
      recentlyUsedTools.add(event.toolName);
      // Native MCP can register tools asynchronously after a mode switch.
      // Enforce the desktop policy at execution as well as declaration time.
      if (modeRef.toolPreset === "none" && modeRef.current !== "plan") return askBlockResult();
      if (modeRef.current === "plan") {
        const allowed =
          PLAN_TOOLS.includes(event.toolName) ||
          PLAN_READONLY_LEGACY_TOOLS.has(event.toolName) ||
          isPlanAllowedDomainCall(event.toolName, event.input);
        if (!allowed) return askBlockResult();
      }
      if (event.toolName === "codemode" && !modeRef.codemodeEnabled) return askBlockResult();
      const confirmMcp = modeRef.current === "ask" && isMcpTool(event.toolName);
      const confirmBg = modeRef.current === "ask" && event.toolName === "run_bg";
      if (!confirmMcp && !confirmBg && !needsAskConfirm(modeRef.current, event.toolName)) return;
      const ok = await ctx.ui.confirm(
        `允许 ${event.toolName}?`,
        summarizeToolCall(event.toolName, event.input)
      );
      if (!ok) return askBlockResult();
    });
  };
}

export function desktopApprovalInlineExtension(modeRef: AgentModeRef): InlineExtension {
  return {
    name: "desktop-approval",
    factory: createDesktopApprovalFactory(modeRef),
  };
}
