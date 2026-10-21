import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "./sdk-adapter.ts";
import { createDesktopPowerShellFactory } from "./desktop-powershell-extension.ts";
import { resolvePowerShell } from "./powershell.ts";

const isWindows = process.platform === "win32";

/**
 * The SDK resolves PowerShell via `where pwsh.exe` / `where powershell.exe`.
 * Some Windows CI images expose PowerShell by absolute path but not on the
 * child_process PATH; the execution test cannot run there and should skip
 * instead of crashing the whole suite. Mirrors the SDK probe (including its
 * existsSync check), so we skip exactly when the SDK would throw.
 */
function sdkCanFindPowerShell(): boolean {
  if (!isWindows || !resolvePowerShell()) return false;
  return ["pwsh.exe", "powershell.exe"].some((exe) => {
    try {
      const result = spawnSync("where.exe", [exe], {
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
      });
      const first = (result.stdout ?? "")
        .split("\n")
        .map((line) => line.trim())
        .find(Boolean);
      return result.status === 0 && Boolean(first && existsSync(first));
    } catch {
      return false;
    }
  });
}

const hasPowerShell = sdkCanFindPowerShell();

test("registers the native PowerShell tool on Windows", () => {
  const tools: Array<Record<string, unknown>> = [];
  const pi = {
    getAllTools: () => [],
    registerTool: (tool: Record<string, unknown>) => tools.push(tool),
  } as unknown as ExtensionAPI;
  createDesktopPowerShellFactory(() => process.cwd())(pi);
  if (isWindows) {
    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.name, "powershell");
  } else {
    assert.equal(tools.length, 0);
  }
});

test("does not double-register when powershell already exists", () => {
  const tools: Array<Record<string, unknown>> = [];
  const pi = {
    getAllTools: () => [{ name: "powershell", description: "existing" }],
    registerTool: (tool: Record<string, unknown>) => tools.push(tool),
  } as unknown as ExtensionAPI;
  createDesktopPowerShellFactory(() => process.cwd())(pi);
  assert.equal(tools.length, 0);
});

test(
  "registered PowerShell tool executes UTF-8 multiline commands",
  { skip: !hasPowerShell && "PowerShell not discoverable by the SDK in this environment", timeout: 30000 },
  async () => {
    const tools: Array<{
      execute: (
        id: string,
        params: { command: string; timeout?: number },
        signal?: AbortSignal,
        onUpdate?: unknown,
        ctx?: unknown,
      ) => Promise<{ content: Array<{ type: string; text?: string }> }>;
    }> = [];
    const pi = {
      getAllTools: () => [],
      registerTool: (tool: never) => tools.push(tool),
    } as unknown as ExtensionAPI;
    createDesktopPowerShellFactory(() => process.cwd())(pi);
    const definition = tools[0];
    assert.ok(definition);
    const result = await definition.execute(
      "ps-1",
      { command: "Write-Output '第一行'; Write-Output 'second \"quoted\" line'" },
      undefined,
      undefined,
      {
        cwd: process.cwd(),
        sessionManager: {
          getSessionId: () => "test-session",
          getSessionFile: () => null,
        },
      },
    );
    const text = result.content.map((block) => block.text ?? "").join("\n");
    assert.match(text, /第一行/);
    assert.match(text, /second "quoted" line/);
  },
);
