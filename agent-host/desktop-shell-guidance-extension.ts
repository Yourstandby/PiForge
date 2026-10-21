/**
 * Inline pi extension: tell the model when to use `powershell` vs `bash`.
 *
 * Windows 上两个工具都可用，但代价不同：
 * - `powershell` 是原生进程，启动快，不受 MSYS fork 崩溃（`Win32 error 299/5`）影响；
 * - `bash` 走 Git Bash，适合 POSIX 管道、`git`、`sed/grep/xargs`，但启动更慢且偶发崩溃重试。
 *
 * 这些 bullets 通过 `before_agent_start` 的 `systemPromptOptions.promptGuidelines`
 * 追加（pi 会把变化写成 transcript delta，不会破坏 prompt cache）。
 */
import type { ExtensionAPI, ExtensionFactory, InlineExtension } from "./sdk-adapter.ts";

const SHELL_GUIDANCE = [
  "On Windows prefer the `powershell` tool for shell work: it starts faster than Git Bash and avoids MSYS fork failures (`Win32 error 299/5`, `couldn't create signal pipe`).",
  "Use `bash` only when the task needs Git/MSYS tooling or POSIX pipelines (`grep -r`, `sed`, `xargs`, `git` with Unix-style paths).",
  "Batch independent commands into one shell call (`;` in PowerShell, `&&` in bash): every extra tool round-trip re-sends the whole transcript and costs more than the command itself.",
  "Trim output inside the command (`Select-Object -First 40`, `| head -20`, `Select-String`): long dumps are truncated anyway and still cost input tokens.",
];

export function createDesktopShellGuidanceFactory(): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    if (process.platform !== "win32") return;
    pi.on("before_agent_start", (event) => {
      const options = event.systemPromptOptions;
      const existing = options.promptGuidelines ?? [];
      const missing = SHELL_GUIDANCE.filter((line) => !existing.includes(line));
      if (missing.length === 0) return;
      options.promptGuidelines = [...existing, ...missing];
    });
  };
}

export function desktopShellGuidanceInlineExtension(): InlineExtension {
  return {
    name: "desktop-shell-guidance",
    factory: createDesktopShellGuidanceFactory(),
  };
}
