import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BROWSER_PREVIEW_TOOL_NAME } from "./browser-bridge.ts";
import { createDesktopBrowserFactory, requestedBrowserPermissions } from "./desktop-browser-extension.ts";
import {
  clearAllBrowserSessionGrants,
  forgetSessionBrowserPermissions,
} from "./browser-permissions.ts";
import { writeDesktopSettings } from "../lib/desktop-settings.ts";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

type Handler = (event: unknown, ctx?: unknown) => unknown;

function setup(options: { confirm: (title: string, message: string) => boolean; sessionId?: string }) {
  const handlers = new Map<string, Handler>();
  const confirmations: Array<{ title: string; message: string }> = [];
  const pi = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    registerTool: () => {},
    setActiveTools: () => {},
    getAllTools: () => [],
    getActiveTools: () => [],
  } as unknown as ExtensionAPI;
  createDesktopBrowserFactory()(pi);
  const sessionId = options.sessionId ?? "session-under-test";
  const ctx = {
    ui: {
      confirm: async (title: string, message: string) => {
        confirmations.push({ title, message });
        return options.confirm(title, message);
      },
    },
    sessionManager: { getSessionId: () => sessionId },
  };
  return { handlers, confirmations, ctx, sessionId };
}

async function callTool(
  handlers: Map<string, Handler>,
  ctx: unknown,
  input: Record<string, unknown>,
) {
  const handler = handlers.get("tool_call");
  assert.ok(handler, "tool_call handler must be registered");
  return handler({ type: "tool_call", toolName: BROWSER_PREVIEW_TOOL_NAME, toolCallId: "call-1", input }, ctx);
}

test("requestedBrowserPermissions maps actions to capabilities", () => {
  assert.deepEqual(requestedBrowserPermissions("open", undefined), ["interact"]);
  assert.deepEqual(requestedBrowserPermissions("read", undefined), ["read"]);
  assert.deepEqual(requestedBrowserPermissions("screenshot", undefined), ["read"]);
  // Navigating first needs interaction too.
  assert.deepEqual(requestedBrowserPermissions("read", "http://localhost:3000"), ["read", "interact"]);
  assert.deepEqual(requestedBrowserPermissions("screenshot", "https://example.com"), ["read", "interact"]);
  assert.deepEqual(requestedBrowserPermissions("unknown", undefined), []);
});

test("a denied confirmation blocks web_preview", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-browser-hook-deny-"));
  const previous = process.env[AGENT_DIR_ENV];
  process.env[AGENT_DIR_ENV] = dir;
  clearAllBrowserSessionGrants();
  try {
    const { handlers, confirmations, ctx } = setup({ confirm: () => false });
    const result = (await callTool(handlers, ctx, { action: "read" })) as { block?: boolean; reason?: string };
    assert.equal(confirmations.length, 1);
    assert.match(confirmations[0].message, /读取网页内容/);
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /未授予「读取网页内容」/);
  } finally {
    clearAllBrowserSessionGrants();
    if (previous === undefined) delete process.env[AGENT_DIR_ENV];
    else process.env[AGENT_DIR_ENV] = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an approved confirmation grants the capability for that session only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-browser-hook-grant-"));
  const previous = process.env[AGENT_DIR_ENV];
  process.env[AGENT_DIR_ENV] = dir;
  clearAllBrowserSessionGrants();
  try {
    const { handlers, confirmations, ctx, sessionId } = setup({ confirm: () => true });
    assert.equal(await callTool(handlers, ctx, { action: "read" }), undefined);
    assert.equal(confirmations.length, 1);

    // Same session: no second prompt.
    assert.equal(await callTool(handlers, ctx, { action: "screenshot" }), undefined);
    assert.equal(confirmations.length, 1);

    // Interaction is a separate capability and still needs confirmation.
    const openBlocked = (await callTool(handlers, ctx, { action: "open", url: "http://localhost:3000" })) as
      | { block?: boolean }
      | undefined;
    assert.equal(confirmations.length, 2);
    // confirm=true again, so it is granted.
    assert.equal(openBlocked, undefined);

    // Another session does not inherit the grants.
    forgetSessionBrowserPermissions(sessionId);
    const other = setup({ confirm: () => false, sessionId: "another-session" });
    const blocked = (await callTool(other.handlers, other.ctx, { action: "read" })) as { block?: boolean };
    assert.equal(blocked?.block, true);
    assert.equal(other.confirmations.length, 1);
  } finally {
    clearAllBrowserSessionGrants();
    if (previous === undefined) delete process.env[AGENT_DIR_ENV];
    else process.env[AGENT_DIR_ENV] = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("globally enabled capabilities never prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-browser-hook-global-"));
  const previous = process.env[AGENT_DIR_ENV];
  process.env[AGENT_DIR_ENV] = dir;
  clearAllBrowserSessionGrants();
  try {
    writeDesktopSettings(dir, {
      defaultAgentMode: "full",
      defaultToolPreset: "default",
      browserReadEnabled: true,
      browserInteractEnabled: true,
    });
    const { handlers, confirmations, ctx } = setup({ confirm: () => false });
    assert.equal(await callTool(handlers, ctx, { action: "read" }), undefined);
    assert.equal(await callTool(handlers, ctx, { action: "open", url: "http://localhost:3000" }), undefined);
    assert.equal(confirmations.length, 0);
  } finally {
    clearAllBrowserSessionGrants();
    if (previous === undefined) delete process.env[AGENT_DIR_ENV];
    else process.env[AGENT_DIR_ENV] = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
