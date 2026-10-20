/**
 * Sandboxed plugin manager (v0.7.0 module 2).
 *
 * Plugins are plain JS/TS files under `<agentDir>/plugins/<plugin>/`. They are
 * evaluated in a `node:vm` context with:
 *   - no require/import/process/fs/child_process/fetch/WebSocket
 *   - code generation (eval/Function) disabled
 *   - a frozen, null-prototype API; host functions expose no constructor chain
 *
 * Plugin tools, prompts and panels are registered here. Tool execution goes
 * through the Host WebSocket bus for privileged work (`api.hostCall`), so the
 * plugin never receives native filesystem or process capabilities.
 *
 * Note: `vm` is an isolation boundary, not a OS sandbox. A future phase can
 * move each plugin into its own permission-restricted worker process; this
 * phase's contract is "no ambient Node capabilities + Host-only RPC".
 */
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import vm from "node:vm";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writeFileAtomic } from "../lib/atomic-write.ts";
import type {
  PluginPanelView,
  PluginStatus,
  PluginToolResult,
  PluginView,
} from "../contract/domains/plugins.ts";
import { createPluginBus, type PluginBus } from "./plugin-bus.ts";

const MAX_PLUGINS = 32;
const MAX_SOURCE_BYTES = 512_000;
const MAX_PROMPT_CHARS = 8_000;
const MAX_PANEL_CHARS = 120_000;
const ACTIVATE_TIMEOUT_MS = 3_000;
const TOOL_TIMEOUT_MS = 30_000;
const API_VERSION = 1;

export interface PluginToolDefinition {
  name: string;
  title: string;
  description: string;
  pluginId: string;
  mcp: boolean;
  inputSchema: Record<string, unknown>;
  handler: (input: Record<string, unknown>) => Promise<unknown> | unknown;
}

export interface PluginManagerOptions {
  pluginsDir?: string;
  agentDir?: string;
  wsUrl?: string | null;
  token?: string;
  log?: (message: string) => void;
  /** Test injection: replaces the real WS bus. */
  bus?: PluginBus | null;
}

interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  main: string;
  enabled: boolean;
  apiVersion: number;
}

interface PluginRecord {
  manifest: PluginManifest;
  dir: string;
  mainPath: string;
  status: PluginStatus;
  error?: string;
  loadedAt: number | null;
  tools: PluginToolDefinition[];
  prompts: string[];
  panels: PluginPanelView[];
  context: vm.Context | null;
  eventUnsubscribe: (() => void) | null;
}

const records = new Map<string, PluginRecord>();
const listeners = new Set<() => void>();
let activeBus: PluginBus | null = null;
let pluginsRoot = "";
let loading = false;
let busUrl: string | null = null;
let busToken = "";

export class PluginManagerError extends Error {
  readonly code = "E_INVALID_PARAMS";
}

function logDefault(message: string): void {
  console.log(`[plugins] ${message}`);
}

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      console.error("plugin listener failed:", error);
    }
  }
}

export function onPluginsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function statePath(agentDir: string): string {
  return join(agentDir, "plugin-state.json");
}

function readEnabledOverrides(agentDir: string): Record<string, boolean> {
  const file = statePath(agentDir);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, boolean> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "boolean") out[id] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function writeEnabledOverrides(agentDir: string, overrides: Record<string, boolean>): void {
  mkdirSync(agentDir, { recursive: true });
  writeFileAtomic(statePath(agentDir), `${JSON.stringify(overrides, null, 2)}\n`);
}

function validPluginId(id: string): boolean {
  return /^[a-z][a-z0-9-]{1,63}$/.test(id);
}

function manifestFor(dir: string, file: string | null, enabledOverrides: Record<string, boolean>): PluginManifest {
  const manifestPath = join(dir, "plugin.json");
  if (existsSync(manifestPath)) {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("plugin.json must be an object");
    }
    const raw = parsed as Record<string, unknown>;
    const id = typeof raw.id === "string" && raw.id ? raw.id : basename(dir);
    if (!validPluginId(id)) throw new Error(`invalid plugin id: ${id}`);
    const main = typeof raw.main === "string" && raw.main.trim() ? raw.main.trim() : "index.js";
    const manifestEnabled = raw.enabled !== false;
    return {
      id,
      name: typeof raw.name === "string" && raw.name.trim() ? raw.name : id,
      version: typeof raw.version === "string" ? raw.version : "0.0.0",
      description: typeof raw.description === "string" ? raw.description : "",
      main,
      enabled: enabledOverrides[id] ?? manifestEnabled,
      apiVersion: typeof raw.apiVersion === "number" ? raw.apiVersion : API_VERSION,
    };
  }
  const id = basename(file ?? dir).replace(/\.(?:js|ts)$/, "");
  if (!validPluginId(id)) throw new Error(`invalid plugin id: ${id}`);
  return {
    id,
    name: id,
    version: "0.0.0",
    description: "Single-file plugin",
    main: file ? basename(file) : "index.js",
    enabled: enabledOverrides[id] ?? true,
    apiVersion: API_VERSION,
  };
}

function resolveMainPath(dir: string, main: string): string {
  const resolved = resolve(dir, main);
  const root = resolve(dir) + sep;
  if (!resolved.startsWith(root)) throw new Error("plugin main must stay inside its plugin directory");
  if (!existsSync(resolved)) throw new Error(`plugin main not found: ${main}`);
  if (statSync(resolved).size > MAX_SOURCE_BYTES) throw new Error("plugin main is too large");
  return resolved;
}

function readPluginSource(mainPath: string): string {
  const source = readFileSync(mainPath, "utf8");
  const ext = extname(mainPath).toLowerCase();
  if (ext === ".ts") {
    // Node 24 ships this; it strips type syntax without executing the file.
    return stripTypeScriptTypes(source, { mode: "strip" });
  }
  return source;
}

function safeFunction<T extends (...args: never[]) => unknown>(fn: T): T {
  const wrapped = ((...args: Parameters<T>) => fn(...args)) as T;
  Object.setPrototypeOf(wrapped, null);
  return Object.freeze(wrapped);
}

function safeConsole(log: (message: string) => void): Record<string, (...args: unknown[]) => void> {
  const write = (level: string) => (...args: unknown[]) => {
    log(`[${level}] ${args.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" ")}`);
  };
  return Object.freeze(Object.assign(Object.create(null), {
    log: safeFunction(write("log") as (...args: never[]) => unknown),
    info: safeFunction(write("info") as (...args: never[]) => unknown),
    warn: safeFunction(write("warn") as (...args: never[]) => unknown),
    error: safeFunction(write("error") as (...args: never[]) => unknown),
  })) as Record<string, (...args: unknown[]) => void>;
}

function toContextValue(context: vm.Context, value: unknown): unknown {
  const json = JSON.stringify(value ?? null);
  // Reject prototype-poisoning keys before creating the literal in the sandbox.
  if (json.includes('"__proto__"') || json.includes('"constructor"') || json.includes('"prototype"')) {
    throw new Error("plugin result/input contains forbidden keys");
  }
  return new vm.Script(`(${json})`).runInContext(context);
}

function wrapThenable(value: Promise<unknown>, context: vm.Context): Record<string, unknown> {
  const thenable = Object.create(null) as Record<string, unknown>;
  const then = safeFunction(((onFulfilled?: unknown, onRejected?: unknown) => {
    const next = value.then(
      (result) => typeof onFulfilled === "function"
        ? (onFulfilled as (arg: unknown) => unknown)(toContextValue(context, result))
        : result,
      (error) => {
        if (typeof onRejected === "function") {
          return (onRejected as (arg: unknown) => unknown)(toContextValue(context, {
            message: error instanceof Error ? error.message : String(error),
          }));
        }
        throw error;
      },
    );
    return wrapThenable(Promise.resolve(next), context);
  }) as (...args: never[]) => unknown);
  thenable.then = then;
  thenable.catch = safeFunction(((onRejected: unknown) => {
    return wrapThenable(value.catch((error) => {
      if (typeof onRejected === "function") {
        return (onRejected as (arg: unknown) => unknown)(toContextValue(context, {
          message: error instanceof Error ? error.message : String(error),
        }));
      }
      throw error;
    }), context);
  }) as (...args: never[]) => unknown);
  return Object.freeze(thenable);
}

function safeApi(record: PluginRecord, bus: PluginBus | null, log: (message: string) => void): Record<string, unknown> {
  const registerTool = (spec: unknown) => {
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("registerTool expects an object");
    const raw = spec as Record<string, unknown>;
    const localName = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(localName)) {
      throw new Error("tool name must be 2-64 lowercase letters/digits/underscores");
    }
    const fullName = `plugin__${record.manifest.id}__${localName}`;
    if (record.tools.some((tool) => tool.name === fullName)) throw new Error(`duplicate tool: ${localName}`);
    if (typeof raw.handler !== "function") throw new Error("tool handler must be a function");
    const schema = raw.inputSchema && typeof raw.inputSchema === "object" && !Array.isArray(raw.inputSchema)
      ? raw.inputSchema as Record<string, unknown>
      : { type: "object", properties: {} };
    const mcp = raw.mcp === true;
    record.tools.push({
      name: fullName,
      title: typeof raw.title === "string" && raw.title.trim() ? raw.title : localName,
      description: typeof raw.description === "string" ? raw.description.slice(0, 2_000) : "",
      pluginId: record.manifest.id,
      mcp,
      inputSchema: schema,
      handler: (input) => {
        if (!record.context) throw new Error("plugin context is not loaded");
        const contextInput = toContextValue(record.context, input);
        return (raw.handler as (value: unknown) => unknown)(contextInput);
      },
    });
    return fullName;
  };

  const api = Object.create(null) as Record<string, unknown>;
  api.apiVersion = API_VERSION;
  api.pluginId = record.manifest.id;
  api.registerTool = safeFunction(registerTool as (...args: never[]) => unknown);
  // MCP-style alias: tools are exposed to the agent through the same registry
  // and flagged for the Plugins panel. The Host does not open a second MCP
  // transport for plugin-local tools in this phase.
  api.registerMcpTool = safeFunction(((spec: Record<string, unknown>) => registerTool({ ...spec, mcp: true })) as (...args: never[]) => unknown);
  api.registerPrompt = safeFunction(((text: unknown) => {
    if (typeof text !== "string" || !text.trim()) throw new Error("registerPrompt expects a string");
    if (text.length > MAX_PROMPT_CHARS) throw new Error("prompt is too large");
    record.prompts.push(text.trim());
  }) as (...args: never[]) => unknown);
  api.registerPanel = safeFunction(((spec: unknown) => {
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("registerPanel expects an object");
    const raw = spec as Record<string, unknown>;
    const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : randomUUID();
    const title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : id;
    const body = typeof raw.body === "string" ? raw.body : "";
    if (body.length > MAX_PANEL_CHARS) throw new Error("panel body is too large");
    record.panels.push({ id: `${record.manifest.id}:${id}`, title, body });
  }) as (...args: never[]) => unknown);
  api.hostCall = safeFunction(((method: unknown, params?: unknown) => {
    const context = record.context;
    if (!context) {
      throw new Error("plugin context is not loaded");
    }
    if (typeof method !== "string" || !method.trim()) {
      return wrapThenable(Promise.reject(new Error("method is required")), context);
    }
    if (!bus) {
      return wrapThenable(Promise.reject(new Error("plugin bus is unavailable")), context);
    }
    const cleanParams = params && typeof params === "object" && !Array.isArray(params)
      ? params as Record<string, unknown>
      : {};
    return wrapThenable(bus.call(method, cleanParams), context);
  }) as (...args: never[]) => unknown);
  api.publish = safeFunction(((topic: unknown, payload?: unknown) => {
    if (typeof topic !== "string" || !topic) throw new Error("topic is required");
    bus?.publish(topic, payload ?? null);
  }) as (...args: never[]) => unknown);
  api.log = safeFunction(((message: unknown) => {
    log(typeof message === "string" ? message : JSON.stringify(message));
  }) as (...args: never[]) => unknown);
  api.onEvent = safeFunction(((handler: unknown) => {
    if (typeof handler !== "function") throw new Error("onEvent expects a function");
    if (!bus) return () => {};
    return bus.onEvent((topic, payload) => {
      try {
        const context = record.context;
        if (!context) return;
        (handler as (topic: string, payload: unknown) => void)(
          topic,
          toContextValue(context, payload),
        );
      } catch (error) {
        log(`event handler failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }) as (...args: never[]) => unknown);
  return Object.freeze(api);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function loadPlugin(
  dir: string,
  file: string | null,
  enabledOverrides: Record<string, boolean>,
  bus: PluginBus | null,
  log: (message: string) => void,
): Promise<PluginRecord> {
  const manifest = manifestFor(dir, file, enabledOverrides);
  const mainPath = resolveMainPath(dir, manifest.main);
  const record: PluginRecord = {
    manifest,
    dir,
    mainPath,
    status: manifest.enabled ? "loaded" : "disabled",
    loadedAt: null,
    tools: [],
    prompts: [],
    panels: [],
    context: null,
    eventUnsubscribe: null,
  };
  if (!manifest.enabled) return record;
  if (manifest.apiVersion !== API_VERSION) {
    record.status = "error";
    record.error = `unsupported apiVersion ${manifest.apiVersion} (host supports ${API_VERSION})`;
    return record;
  }
  try {
    const source = readPluginSource(mainPath);
    const context = vm.createContext({
      console: safeConsole(log),
      __pluginFilename: mainPath,
    }, {
      name: `plugin:${manifest.id}`,
      codeGeneration: { strings: false, wasm: false },
    });
    record.context = context;
    // Create module/exports inside the sandbox so their constructors belong to
    // the context, not the Host realm.
    const moduleObject = new vm.Script("({ exports: {} })").runInContext(context) as {
      exports: Record<string, unknown>;
    };
    Object.setPrototypeOf(moduleObject, null);
    Object.defineProperty(context, "module", { value: moduleObject, writable: true, configurable: true });
    Object.defineProperty(context, "exports", { value: moduleObject.exports, writable: true, configurable: true });
    const api = safeApi(record, bus, log);
    const wrapper = new vm.Script(
      `(function(module, exports, api) {\n"use strict";\n${source}\n})`,
      { filename: mainPath },
    );
    const factory = wrapper.runInContext(context, { timeout: 1_000 }) as (
      module: typeof moduleObject,
      exports: Record<string, unknown>,
      api: Record<string, unknown>,
    ) => unknown;
    const returned = factory(moduleObject, moduleObject.exports, api);
    const exported = (moduleObject.exports ?? {}) as Record<string, unknown>;
    const activate = typeof exported.activate === "function"
      ? exported.activate
      : typeof returned === "function"
        ? returned
        : null;
    if (!activate) throw new Error("plugin must export activate(api)");
    await withTimeout(
      Promise.resolve((activate as (api: Record<string, unknown>) => unknown)(api)),
      ACTIVATE_TIMEOUT_MS,
      "plugin activate",
    );
    record.loadedAt = Date.now();
  } catch (error) {
    record.status = "error";
    record.error = error instanceof Error ? error.message : String(error);
    record.tools = [];
    record.prompts = [];
    record.panels = [];
    log(`${manifest.id} failed to load: ${record.error}`);
  }
  return record;
}

function discover(pluginsDir: string): Array<{ dir: string; file: string | null }> {
  if (!existsSync(pluginsDir)) return [];
  const entries: Array<{ dir: string; file: string | null }> = [];
  for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (entries.length >= MAX_PLUGINS) break;
    const full = join(pluginsDir, entry.name);
    if (entry.isDirectory()) {
      if (existsSync(join(full, "plugin.json")) || existsSync(join(full, "index.js")) || existsSync(join(full, "index.ts"))) {
        entries.push({ dir: full, file: null });
      }
    } else if (entry.isFile() && /\.(?:js|ts)$/.test(entry.name)) {
      entries.push({ dir: pluginsDir, file: full });
    }
  }
  return entries.sort((a, b) => a.dir.localeCompare(b.dir));
}


export async function initPlugins(options: PluginManagerOptions = {}): Promise<PluginView[]> {
  if (loading) return listPlugins();
  loading = true;
  try {
    stopPlugins();
    const agentDir = options.agentDir ?? getAgentDir();
    pluginsRoot = options.pluginsDir ?? join(agentDir, "plugins");
    const log = options.log ?? logDefault;
    if (options.wsUrl !== undefined) busUrl = options.wsUrl;
    if (options.token !== undefined) busToken = options.token;
    const bus = options.bus !== undefined
      ? options.bus
      : options.wsUrl && options.token
        ? createPluginBus(options.wsUrl, options.token, log)
        : null;
    activeBus = bus;
    const overrides = readEnabledOverrides(agentDir);
    for (const item of discover(pluginsRoot)) {
      let record: PluginRecord;
      try {
        record = await loadPlugin(item.dir, item.file, overrides, bus, log);
      } catch (error) {
        // A malformed manifest still appears in the UI so the user can fix it.
        const fallbackId = basename(item.file ?? item.dir).replace(/\.(?:js|ts)$/, "");
        record = {
          manifest: {
            id: validPluginId(fallbackId) ? fallbackId : `invalid-${randomUUID().slice(0, 8)}`,
            name: fallbackId,
            version: "0.0.0",
            description: "",
            main: "",
            enabled: true,
            apiVersion: API_VERSION,
          },
          dir: item.dir,
          mainPath: "",
          status: "error",
          error: error instanceof Error ? error.message : String(error),
          loadedAt: null,
          tools: [],
          prompts: [],
          panels: [],
          context: null,
          eventUnsubscribe: null,
        };
      }
      if (!records.has(record.manifest.id)) records.set(record.manifest.id, record);
    }
    notify();
    return listPlugins();
  } finally {
    loading = false;
  }
}

export async function reloadPlugins(): Promise<PluginView[]> {
  const agentDir = pluginsRoot ? dirname(pluginsRoot) : getAgentDir();
  return initPlugins({
    agentDir,
    pluginsDir: pluginsRoot || undefined,
    wsUrl: busUrl,
    token: busToken,
  });
}

export function stopPlugins(): void {
  for (const record of records.values()) {
    try {
      record.eventUnsubscribe?.();
    } catch {
      // ignore
    }
  }
  records.clear();
  activeBus?.close();
  activeBus = null;
}

export function listPlugins(): PluginView[] {
  return [...records.values()]
    .map(toView)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function toView(record: PluginRecord): PluginView {
  return {
    id: record.manifest.id,
    name: record.manifest.name,
    version: record.manifest.version,
    description: record.manifest.description,
    status: record.status,
    enabled: record.manifest.enabled,
    tools: record.tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      mcp: tool.mcp,
    })),
    panels: record.panels.map((panel) => ({ ...panel })),
    prompts: record.prompts.length,
    ...(record.error ? { error: record.error } : {}),
    loadedAt: record.loadedAt,
  };
}

export function listPluginTools(): PluginToolDefinition[] {
  return [...records.values()]
    .filter((record) => record.status === "loaded")
    .flatMap((record) => record.tools.map((tool) => ({ ...tool })));
}

export function pluginPromptAdditions(): string {
  return [...records.values()]
    .filter((record) => record.status === "loaded")
    .flatMap((record) => record.prompts)
    .join("\n\n");
}

export function listPluginPanels(): PluginPanelView[] {
  return [...records.values()]
    .filter((record) => record.status === "loaded")
    .flatMap((record) => record.panels.map((panel) => ({ ...panel })));
}

export async function executePluginTool(
  name: string,
  input: Record<string, unknown>,
): Promise<PluginToolResult> {
  const startedAt = Date.now();
  const tool = listPluginTools().find((candidate) => candidate.name === name);
  if (!tool) {
    return { ok: false, error: `Unknown plugin tool: ${name}`, elapsedMs: 0 };
  }
  try {
    const result = await withTimeout(
      Promise.resolve(tool.handler(input ?? {})),
      TOOL_TIMEOUT_MS,
      `plugin tool ${name}`,
    );
    return {
      ok: true,
      result: result === undefined ? null : JSON.parse(JSON.stringify(result)),
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - startedAt,
    };
  }
}

export async function setPluginEnabled(id: string, enabled: boolean, agentDir = getAgentDir()): Promise<PluginView> {
  const record = records.get(id);
  if (!record) throw new PluginManagerError(`unknown plugin: ${id}`);
  const overrides = readEnabledOverrides(agentDir);
  overrides[id] = enabled;
  writeEnabledOverrides(agentDir, overrides);
  await initPlugins({
    agentDir,
    pluginsDir: pluginsRoot || join(agentDir, "plugins"),
    wsUrl: busUrl,
    token: busToken,
  });
  const updated = records.get(id);
  if (!updated) throw new PluginManagerError(`plugin disappeared after reload: ${id}`);
  return toView(updated);
}

/** Test helper. */
export function resetPluginsForTest(): void {
  stopPlugins();
  pluginsRoot = "";
  busUrl = null;
  busToken = "";
  listeners.clear();
}
