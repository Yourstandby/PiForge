/**
 * Inline pi extension: expose the SDK's native PowerShell tool on Windows.
 *
 * The SDK already resolves `pwsh.exe` before `powershell.exe`, applies
 * `-NoProfile -NonInteractive -ExecutionPolicy Bypass`, and sets UTF-8 console
 * encoding. Registering it here makes PowerShell a first-class desktop tool
 * (the SDK only enables it when listed in `defaultTools`).
 */
import {
  createPowerShellToolDefinition,
  type ExtensionAPI,
  type ExtensionFactory,
  type InlineExtension,
  type ToolDefinition,
} from "./sdk-adapter.ts";
import { registerDomainAction } from "./domain-tools.ts";

export function createDesktopPowerShellFactory(
  getCwd: () => string,
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    if (process.platform !== "win32") return;
    if (pi.getAllTools().some((tool) => tool.name === "powershell")) return;
    // 收进 shell 多态工具：执行时由 `shell{action:"exec"}` 分派回来。
    registerDomainAction(
      pi,
      "shell",
      "exec",
      createPowerShellToolDefinition(getCwd()) as unknown as ToolDefinition
    );
  };
}

export function desktopPowerShellInlineExtension(
  getCwd: () => string,
): InlineExtension {
  return {
    name: "desktop-powershell",
    factory: createDesktopPowerShellFactory(getCwd),
  };
}
