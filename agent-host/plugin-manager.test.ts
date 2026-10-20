import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PluginBus } from "./plugin-bus.ts";
import {
  executePluginTool,
  initPlugins,
  listPlugins,
  listPluginTools,
  pluginPromptAdditions,
  resetPluginsForTest,
  setPluginEnabled,
} from "./plugin-manager.ts";

function workspace(): { agentDir: string; pluginsDir: string } {
  const agentDir = mkdtempSync(join(tmpdir(), "piforge-plugins-"));
  const pluginsDir = join(agentDir, "plugins");
  mkdirSync(pluginsDir, { recursive: true });
  return { agentDir, pluginsDir };
}

function writePlugin(pluginsDir: string, id: string, source: string, manifest: Record<string, unknown> = {}): void {
  const dir = join(pluginsDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify({
    id,
    name: `Plugin ${id}`,
    version: "1.0.0",
    main: "index.ts",
    ...manifest,
  }));
  writeFileSync(join(dir, "index.ts"), source);
}

test("loads TS plugins with tools, prompts and panels in a capability-free sandbox", async () => {
  const { agentDir, pluginsDir } = workspace();
  try {
    writePlugin(pluginsDir, "demo", `
      module.exports = {
        activate(api) {
          if (typeof require !== "undefined") throw new Error("require leaked");
          if (typeof process !== "undefined") throw new Error("process leaked");
          if (typeof fetch !== "undefined") throw new Error("fetch leaked");
          if (api.registerTool.constructor !== undefined) throw new Error("constructor leaked");
          api.registerTool({
            name: "echo",
            title: "Echo",
            description: "Echo input",
            inputSchema: { type: "object", properties: { text: { type: "string" } } },
            handler(input) {
              return { echo: String(input.text ?? ""), safe: typeof require === "undefined" };
            },
          });
          api.registerMcpTool({
            name: "mcp_echo",
            title: "MCP Echo",
            description: "MCP-flagged echo",
            handler() { return "mcp-ok"; },
          });
          api.registerPrompt("Always answer in Simplified Chinese.");
          api.registerPanel({ id: "info", title: "Demo panel", body: "hello panel" });
        },
      };
    `);
    const plugins = await initPlugins({ agentDir, pluginsDir, wsUrl: null, bus: null });
    assert.equal(plugins.length, 1);
    assert.equal(plugins[0].status, "loaded");
    assert.equal(plugins[0].tools.length, 2);
    assert.equal(plugins[0].panels[0].body, "hello panel");
    assert.match(pluginPromptAdditions(), /Simplified Chinese/);
    assert.equal(listPluginTools().find((tool) => tool.name.endsWith("mcp_echo"))?.mcp, true);

    const result = await executePluginTool("plugin__demo__echo", { text: "hi" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.result, { echo: "hi", safe: true });
  } finally {
    resetPluginsForTest();
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("hostCall crosses the real plugin-bus contract and hides host constructors", async () => {
  const { agentDir, pluginsDir } = workspace();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const fakeBus: PluginBus = {
    connected: true,
    call: async (method, params = {}) => {
      calls.push({ method, params });
      return { path: "D:/authorized" };
    },
    publish: () => {},
    onEvent: () => () => {},
    close: () => {},
  };
  try {
    writePlugin(pluginsDir, "rpc", `
      module.exports = {
        activate(api) {
          if (module.constructor !== undefined) throw new Error("module constructor leaked");
          if (api.hostCall.constructor !== undefined) throw new Error("hostCall constructor leaked");
          api.registerTool({
            name: "ask_host",
            handler: async (input) => {
              const result = await api.hostCall("files.authorize", { path: input.path, mode: "read" });
              return { path: result.path, promiseConstructor: api.hostCall("host.health").constructor };
            },
          });
        },
      };
    `);
    await initPlugins({ agentDir, pluginsDir, bus: fakeBus });
    const result = await executePluginTool("plugin__rpc__ask_host", { path: "D:/x" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.result, { path: "D:/authorized" });
    assert.equal(calls[0].method, "files.authorize");
    assert.equal(calls[0].params.path, "D:/x");
    assert.equal(calls[0].params.mode, "read");
  } finally {
    resetPluginsForTest();
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("plugin requiring native modules fails closed and is reported", async () => {
  const { agentDir, pluginsDir } = workspace();
  try {
    writePlugin(pluginsDir, "bad", `const fs = require("node:fs"); module.exports = { activate() {} };`);
    const plugins = await initPlugins({ agentDir, pluginsDir, bus: null });
    assert.equal(plugins[0].status, "error");
    assert.match(plugins[0].error ?? "", /require is not defined/);
    assert.equal(listPluginTools().length, 0);
  } finally {
    resetPluginsForTest();
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("main path traversal is rejected", async () => {
  const { agentDir, pluginsDir } = workspace();
  try {
    writePlugin(pluginsDir, "escape", `module.exports = { activate() {} };`, { main: "../outside.js" });
    const plugins = await initPlugins({ agentDir, pluginsDir, bus: null });
    assert.equal(plugins[0].status, "error");
    assert.match(plugins[0].error ?? "", /inside its plugin directory/);
  } finally {
    resetPluginsForTest();
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("enable/disable persists through plugin-state.json and reloads tools", async () => {
  const { agentDir, pluginsDir } = workspace();
  try {
    writePlugin(pluginsDir, "toggle", `
      module.exports = { activate(api) { api.registerTool({ name: "ping", handler: () => "pong" }); } };
    `);
    await initPlugins({ agentDir, pluginsDir, bus: null });
    assert.equal(listPlugins()[0].enabled, true);
    const disabled = await setPluginEnabled("toggle", false, agentDir);
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.status, "disabled");
    assert.equal(listPluginTools().length, 0);
    const enabled = await setPluginEnabled("toggle", true, agentDir);
    assert.equal(enabled.enabled, true);
    assert.equal(listPluginTools().length, 1);
  } finally {
    resetPluginsForTest();
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("tool timeouts and unknown tools return structured failures", async () => {
  const { agentDir, pluginsDir } = workspace();
  try {
    writePlugin(pluginsDir, "slow", `
      module.exports = { activate(api) { api.registerTool({ name: "hang", handler: () => new Promise(() => {}) }); } };
    `);
    await initPlugins({ agentDir, pluginsDir, bus: null });
    const unknown = await executePluginTool("plugin__nope__x", {});
    assert.equal(unknown.ok, false);
    assert.match(unknown.error ?? "", /Unknown plugin tool/);
  } finally {
    resetPluginsForTest();
    rmSync(agentDir, { recursive: true, force: true });
  }
});
