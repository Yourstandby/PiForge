import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDesktopPowerShellFactory } from "./desktop-powershell-extension.ts";

const isWindows = process.platform === "win32";

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

test("registered PowerShell tool executes UTF-8 multiline commands", { skip: !isWindows, timeout: 30000 }, async () => {
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
});
