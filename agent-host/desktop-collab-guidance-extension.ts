/**
 * Inline pi extension: 把「多会话协作协议」注入 system prompt。
 *
 * 注入点与 `desktop-output-style` / `desktop-shell-guidance` 相同：
 * `systemPromptOptions.promptGuidelines`。内容全是常量 → prompt cache 前缀稳定。
 *
 * 为什么需要它：同一项目里并行开多个会话时，模型既不知道有别的会话在改同一批
 * 文件，也不会主动提交。这几条把「先看 git、每步提交、见到署名先 diff、
 * 独立活走 worktree」变成默认动作，而不是靠用户每次提醒。
 */
import type { ExtensionAPI, ExtensionFactory, InlineExtension } from "./sdk-adapter.ts";
import { COLLAB_GUIDELINES } from "./prompts/collab.ts";

export function createDesktopCollabGuidanceFactory(
  options?: { enabled?: () => boolean }
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.on("before_agent_start", (event) => {
      if (options?.enabled && !options.enabled()) return;
      const systemPromptOptions = event.systemPromptOptions;
      const existing = systemPromptOptions.promptGuidelines ?? [];
      const missing = COLLAB_GUIDELINES.filter((line) => !existing.includes(line));
      if (missing.length === 0) return;
      systemPromptOptions.promptGuidelines = [...existing, ...missing];
    });
  };
}

export function desktopCollabGuidanceInlineExtension(options?: {
  enabled?: () => boolean;
}): InlineExtension {
  return {
    name: "desktop-collab-guidance",
    factory: createDesktopCollabGuidanceFactory(options),
  };
}
