/**
 * Inline pi extension: 5 个多态工具（browser / shell / fleet / orchestrator / memory）。
 *
 * **必须最后加载**：它从 `domain-tools.ts` 的注册表读出前面各扩展登记的动作，
 * 现场合成 schema。执行时不复制任何逻辑，只用 `ctx.executeTool()` 分派回原工具，
 * 因此审批、事件、结果渲染、错误文案全部沿用旧实现。
 *
 * 顺带承载「留在静态前缀里的 4 条 shell 约束」（其余 per-tool 说明随旧工具一起
 * 变成 deferred，不再每轮付钱）—— 挂在 shell 多态定义上，只有 shell 真被声明时
 * 才进 system prompt。
 */
import type { ExtensionAPI, ExtensionFactory, InlineExtension, ToolDefinition } from "./sdk-adapter.ts";
import { buildDomainToolDefinitions } from "./domain-tools.ts";
import { SHELL_GUIDANCE } from "./desktop-shell-guidance-extension.ts";

/** 只在 shell 多态工具被声明时挂上这 4 条约束。 */
function withShellGuidelines(definition: ToolDefinition): ToolDefinition {
  if (definition.name !== "shell") return definition;
  return { ...definition, promptGuidelines: [...SHELL_GUIDANCE] };
}

export function createDesktopDomainFactory(): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    const definitions = buildDomainToolDefinitions();
    if (process.env.PIFORGE_DEBUG_DOMAIN === "1") {
      console.log(
        "[domain-tools] registering:",
        definitions.map((definition) => definition.name).join(", ") || "(none)"
      );
    }
    for (const definition of definitions) {
      pi.registerTool(withShellGuidelines(definition));
    }
  };
}

export function desktopDomainInlineExtension(): InlineExtension {
  return {
    name: "desktop-domain-tools",
    factory: createDesktopDomainFactory(),
  };
}
