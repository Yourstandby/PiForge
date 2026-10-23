/**
 * Inline pi extension: 把「反废话」输出约束注入 system prompt。
 *
 * 注入点是 `systemPromptOptions.promptGuidelines`（与 shell guidance 同一机制）：
 * pi 会把它渲染成提示词的**稳定**尾部段落，内容全是常量 → prompt cache 前缀不抖动。
 * 不在这里读文件、不拼时间戳、不拼会话 id。
 */
import type { ExtensionAPI, ExtensionFactory, InlineExtension } from "./sdk-adapter.ts";
import { OUTPUT_STYLE_GUIDELINES } from "./prompts/output-style.ts";

export function createDesktopOutputStyleFactory(
  options?: { enabled?: () => boolean }
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.on("before_agent_start", (event) => {
      // 设置项控制（默认开）：用户关掉后这段不进步 system prompt，工具与上下文不变。
      if (options?.enabled && !options.enabled()) return;
      const options_ = event.systemPromptOptions;
      const existing = options_.promptGuidelines ?? [];
      const missing = OUTPUT_STYLE_GUIDELINES.filter((line) => !existing.includes(line));
      if (missing.length === 0) return;
      options_.promptGuidelines = [...existing, ...missing];
    });
  };
}

export function desktopOutputStyleInlineExtension(options?: {
  enabled?: () => boolean;
}): InlineExtension {
  return {
    name: "desktop-output-style",
    factory: createDesktopOutputStyleFactory(options),
  };
}
