/**
 * Inline pi extension: 把「反废话」输出约束 + 「少往返」调用预算注入 system prompt。
 *
 * 注入点是 `systemPromptOptions.promptGuidelines`（与 shell guidance 同一机制）：
 * pi 会把它渲染成提示词的**稳定**尾部段落，内容全是常量 → prompt cache 前缀不抖动。
 * 不在这里读文件、不拼时间戳、不拼会话 id。
 *
 * 两组文本的开关互相独立：
 *   - OUTPUT_STYLE_GUIDELINES 受设置项控制（用户可感知的输出偏好）；
 *   - BATCHING_RULES 常驻（效率契约，关掉只会在长任务里重复跑同样的探针）。
 */
import type { ExtensionAPI, ExtensionFactory, InlineExtension } from "./sdk-adapter.ts";
import { BATCHING_RULES, OUTPUT_STYLE_GUIDELINES } from "./prompts/output-style.ts";

export function createDesktopOutputStyleFactory(
  options?: { enabled?: () => boolean }
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.on("before_agent_start", (event) => {
      const options_ = event.systemPromptOptions;
      const existing = options_.promptGuidelines ?? [];
      // 设置项只能关掉输出风格；调用预算始终追加。
      const styleOn = !(options?.enabled && !options.enabled());
      const wanted = styleOn
        ? [...OUTPUT_STYLE_GUIDELINES, ...BATCHING_RULES]
        : [...BATCHING_RULES];
      const missing = wanted.filter((line) => !existing.includes(line));
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
