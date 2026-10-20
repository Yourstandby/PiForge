/**
 * MCP management service (v0.5.0 stage 1).
 *
 * Everything that touches an MCP server lives here, inside the Agent Host:
 * connection probes, OAuth sign-in / refresh / sign-out, and resource reads.
 * The Next.js side only forwards RPC calls through `contract/domains/mcp.ts`.
 *
 * Credentials use pi's own `<agent-dir>/mcp-auth.json` layout, keyed by
 * `mcp__<server>|<url>`, so a sign-in performed here is picked up by the Pi
 * sessions running in this same host process.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  McpAuthRequiredError,
  McpClient,
  McpError,
  StdioTransport,
  StreamableHttpTransport,
  type AuthProvider,
  type McpTransport,
  type Tool as McpTool,
} from "@earendil-works/pi-mcp";
import {
  McpOAuthAuthorizationRequiredError,
  McpOAuthProvider,
  OAuthCallbackServer,
  authorizeMcp,
  parseWwwAuthenticate,
  type McpOAuthState,
  type McpOAuthStateStore,
  type OAuthChallenge,
} from "@earendil-works/pi-mcp/oauth";
import {
  getAgentDir,
  type LoadedMcpConfig,
  type McpServerConfig,
  type McpServerEntry,
} from "@earendil-works/pi-coding-agent";
import { writeFileAtomic } from "../lib/atomic-write.ts";
import { loadDesktopMcpConfig } from "../lib/mcp-config.ts";
import { evaluateProjectTrust } from "../lib/project-trust-desktop.ts";
import { getSessionOnlyTrustMap } from "./trust-store.ts";
import type {
  McpAuthState,
  McpConnectionConfig,
  McpConnectionReport,
  McpPendingLogin,
  McpResourceContent,
  McpResourceReadResult,
  McpResourceSummary,
  McpResourceTemplateSummary,
  McpScope,
  McpToolSummary,
} from "../contract/domains/mcp.ts";

const CLIENT_INFO = { name: "piforge", version: "1.0.0" };
/** Loopback callback path used when the server does not configure one. */
const DEFAULT_CALLBACK_PATH = "/callback";
const DEFAULT_CALLBACK_URL = `http://127.0.0.1${DEFAULT_CALLBACK_PATH}`;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
const POOL_IDLE_MS = 45_000;
/** Text resources larger than this are clipped before crossing the pipe. */
const MAX_RESOURCE_TEXT = 256 * 1024;
const REFRESH_SKEW_MS = 30_000;

export type McpServiceErrorCode =
  | "MCP_SERVER_NOT_FOUND"
  | "MCP_PROJECT_UNTRUSTED"
  | "MCP_AUTH_REQUIRED"
  | "E_INVALID_PARAMS";

export class McpServiceError extends Error {
  readonly code: McpServiceErrorCode;

  constructor(code: McpServiceErrorCode, message: string) {
    super(message);
    this.name = "McpServiceError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Credential store (pi-compatible mcp-auth.json)
// ---------------------------------------------------------------------------

function namespaceFor(serverName: string): string {
  return `mcp__${serverName.replace(/-/g, "_")}`;
}

function authKeys(serverName: string, serverUrl: string): { key: string; legacyKey: string } {
  const url = String(new URL(serverUrl));
  return { key: `${namespaceFor(serverName)}|${url}`, legacyKey: url };
}

function parseAuthStates(content: string | undefined): Record<string, McpOAuthState> {
  if (!content?.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, McpOAuthState>;
  } catch {
    return {};
  }
}

/** Minimal single-process state store; writes are atomic so readers never tear. */
class McpAuthFileStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private read(): Record<string, McpOAuthState> {
    if (!existsSync(this.filePath)) return {};
    try {
      return parseAuthStates(readFileSync(this.filePath, "utf-8"));
    } catch {
      return {};
    }
  }

  private write(states: Record<string, McpOAuthState>): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileAtomic(this.filePath, `${JSON.stringify(states, null, 2)}\n`);
  }

  load(serverName: string, serverUrl: string): McpOAuthState | undefined {
    const states = this.read();
    const { key, legacyKey } = authKeys(serverName, serverUrl);
    if (states[key]) return states[key];
    if (!states[legacyKey]) return undefined;
    // Take over legacy state written by older pi versions.
    const migrated = states[legacyKey];
    const next = { ...states, [key]: migrated };
    delete next[legacyKey];
    this.write(next);
    return migrated;
  }

  save(serverName: string, serverUrl: string, state: McpOAuthState): void {
    const states = this.read();
    const { key } = authKeys(serverName, serverUrl);
    states[key] = state;
    this.write(states);
  }

  remove(serverName: string, serverUrl: string): boolean {
    const states = this.read();
    const { key, legacyKey } = authKeys(serverName, serverUrl);
    const stored = key in states ? key : legacyKey in states ? legacyKey : undefined;
    if (!stored) return false;
    delete states[stored];
    this.write(states);
    return true;
  }

  /**
   * Per-server adapter handed to `McpOAuthProvider`. The provider loads and
   * saves without a server name, so bind both here.
   */
  forServer(serverName: string, serverUrl: string): McpOAuthStateStore {
    return {
      load: () => this.load(serverName, serverUrl),
      save: (state) => this.save(serverName, serverUrl, state),
    };
  }
}

function authStore(): McpAuthFileStore {
  return new McpAuthFileStore(`${getAgentDir()}/mcp-auth.json`);
}

// ---------------------------------------------------------------------------
// Server resolution
// ---------------------------------------------------------------------------

function resolveTrusted(cwd: string | undefined): { cwd: string; trusted: boolean } {
  const resolved = cwd?.trim() || process.cwd();
  const result = evaluateProjectTrust(resolved, {
    sessionOnlyTrust: getSessionOnlyTrustMap(),
  });
  return { cwd: resolved, trusted: result.action === "proceed" ? result.trusted : false };
}

function loadHostConfig(cwd: string | undefined): { loaded: LoadedMcpConfig; cwd: string } {
  const { cwd: resolved, trusted } = resolveTrusted(cwd);
  return { loaded: loadDesktopMcpConfig(getAgentDir(), resolved, trusted), cwd: resolved };
}

/** Resolve one configured server, refusing to connect to an untrusted project entry. */
export function resolveServer(ref: { cwd?: string; serverId: string; scope?: McpScope }): McpServerEntry {
  const serverId = ref.serverId?.trim();
  if (!serverId) throw new McpServiceError("E_INVALID_PARAMS", "serverId is required");
  const { loaded, cwd } = loadHostConfig(ref.cwd);
  const entries = loaded.servers.filter((entry) => entry.name === serverId);
  if (entries.length === 0) {
    const projectEntry = readProjectEntry(cwd, serverId);
    if (projectEntry) {
      throw new McpServiceError(
        "MCP_PROJECT_UNTRUSTED",
        `"${serverId}" is defined in this project's mcp.json. Trust the project before connecting.`,
      );
    }
    throw new McpServiceError("MCP_SERVER_NOT_FOUND", `MCP server "${serverId}" is not configured`);
  }
  if (ref.scope) {
    const scoped = entries.find((entry) => entry.scope === ref.scope || (entry.override && ref.scope === "project"));
    return scoped ?? entries[0];
  }
  return entries[0];
}

/** Detect a project entry that exists but was filtered because the project is untrusted. */
function readProjectEntry(cwd: string, serverId: string): boolean {
  try {
    const path = `${cwd}/.pi/mcp.json`;
    if (!existsSync(path)) return false;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const servers = (parsed as { mcpServers?: unknown }).mcpServers;
    return Boolean(servers && typeof servers === "object" && !Array.isArray(servers) && serverId in (servers as Record<string, unknown>));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Config value resolution
// ---------------------------------------------------------------------------

function resolveValues(values?: Record<string, string>): Record<string, string> | undefined {
  if (!values) return undefined;
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => {
      if (value.startsWith("!")) {
        throw new McpServiceError(
          "E_INVALID_PARAMS",
          `Command-valued credentials (${key}) are resolved by Pi during a session; connect from a session instead.`,
        );
      }
      return [key, value.replace(/\$\{([^}]+)\}/g, (_, name: string) => process.env[name] ?? "")];
    }),
  );
}

interface OAuthSettings {
  clientId?: string;
  clientSecret?: string;
  callbackPort?: number;
  callbackUrl?: string;
  scope?: string;
  clientName?: string;
  clientRegistration?: "dcr" | "cimd";
  authServerMetadataUrl?: URL;
}

function oauthSettings(config: McpServerConfig): OAuthSettings {
  const oauth = "url" in config ? config.oauth : undefined;
  if (!oauth) return {};
  return {
    clientId: oauth.clientId,
    clientSecret: oauth.clientSecret ? resolveValues({ clientSecret: oauth.clientSecret })?.clientSecret : undefined,
    callbackPort: oauth.callbackPort,
    callbackUrl: oauth.callbackUrl,
    scope: oauth.scope,
    clientName: oauth.clientName,
    clientRegistration: oauth.clientRegistration,
    authServerMetadataUrl: oauth.authServerMetadataUrl ? new URL(oauth.authServerMetadataUrl) : undefined,
  };
}

/** HTTP servers without an Authorization header authenticate through OAuth. */
export function usesOAuth(config: McpServerConfig): boolean {
  if (!("url" in config) || config.auth) return false;
  return !Object.keys(config.headers ?? {}).some((header) => header.toLowerCase() === "authorization");
}

function serverUrlOf(entry: McpServerEntry): string | undefined {
  return "url" in entry.config ? entry.config.url : undefined;
}

// ---------------------------------------------------------------------------
// Transports / auth provider
// ---------------------------------------------------------------------------

function callbackTarget(settings: OAuthSettings): {
  host: string;
  redirectHost: string;
  path: string;
  port?: number;
  fixedRedirectUrl?: string;
} {
  if (settings.callbackUrl) {
    const url = new URL(settings.callbackUrl);
    const redirectHost = url.hostname.replace(/^\[|\]$/g, "");
    const explicitPort = url.port ? Number(url.port) : undefined;
    return {
      host: redirectHost === "localhost" ? "127.0.0.1" : redirectHost,
      redirectHost,
      path: url.pathname,
      port: explicitPort ?? settings.callbackPort,
      fixedRedirectUrl: explicitPort ? settings.callbackUrl : undefined,
    };
  }
  return {
    host: "127.0.0.1",
    redirectHost: "127.0.0.1",
    path: DEFAULT_CALLBACK_PATH,
    port: settings.callbackPort,
  };
}

function registeredRedirectUrls(information: unknown): string[] {
  if (!information || typeof information !== "object") return [];
  const urls = (information as { redirect_uris?: unknown }).redirect_uris;
  return Array.isArray(urls) ? urls.filter((value): value is string => typeof value === "string") : [];
}

function createOAuthProvider(options: {
  serverName: string;
  serverUrl: string;
  settings: OAuthSettings;
  redirectUrl: string;
  store: McpAuthFileStore;
  onRedirect?: (url: URL) => void;
}): McpOAuthProvider {
  return new McpOAuthProvider({
    serverUrl: options.serverUrl,
    redirectUrl: options.redirectUrl,
    clientMetadata: { client_name: options.settings.clientName ?? "PiForge" },
    clientId: options.settings.clientId,
    clientSecret: options.settings.clientSecret,
    store: options.store.forServer(options.serverName, options.serverUrl),
    onRedirect: options.onRedirect ?? (() => undefined),
  });
}

function timedFetch(): typeof fetch {
  return (input, init) => {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    return fetch(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
    });
  };
}

/**
 * Bearer-token auth for management connections: send the stored token, refresh
 * it before expiry or after a 401. Sign-in never starts here — the caller is
 * told that a sign-in is required instead.
 */
function createStoredAuthProvider(options: {
  serverName: string;
  serverUrl: string;
  settings: OAuthSettings;
  store: McpAuthFileStore;
}): AuthProvider & { settled(): Promise<void> } {
  const { serverName, serverUrl, settings, store } = options;
  let refreshing: Promise<void> | null = null;

  const fallbackRedirect = (state: McpOAuthState | undefined): string => {
    const target = callbackTarget(settings);
    return (
      target.fixedRedirectUrl ??
      registeredRedirectUrls(state?.clientInformation)[0] ??
      settings.callbackUrl ??
      DEFAULT_CALLBACK_URL
    );
  };

  const refresh = (staleToken: string | undefined, challenge?: OAuthChallenge, networkFetch?: typeof fetch) => {
    refreshing ??= (async () => {
      const state = store.load(serverName, serverUrl);
      if (state?.tokens?.access_token !== staleToken) return;
      if (!state?.tokens?.refresh_token) throw new McpOAuthAuthorizationRequiredError();
      const provider = createOAuthProvider({
        serverName,
        serverUrl,
        settings,
        redirectUrl: fallbackRedirect(state),
        store,
      });
      const result = await authorizeMcp(provider, {
        serverUrl,
        resourceMetadataUrl: challenge?.resourceMetadataUrl,
        authorizationServerMetadataUrl: settings.authServerMetadataUrl,
        scope: challenge?.scope ?? settings.scope,
        fetch: networkFetch ?? timedFetch(),
      });
      if (result === "REDIRECT") throw new McpOAuthAuthorizationRequiredError();
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  };

  return {
    token: async () => {
      await refreshing?.catch(() => undefined);
      const state = store.load(serverName, serverUrl);
      const token = state?.tokens?.access_token;
      const expired = state?.tokensExpireAt !== undefined && state.tokensExpireAt - REFRESH_SKEW_MS <= Date.now();
      if (!expired || !state?.tokens?.refresh_token) return token;
      await refresh(token).catch(() => undefined);
      return store.load(serverName, serverUrl)?.tokens?.access_token;
    },
    onUnauthorized: async (context) => {
      let challenge: OAuthChallenge = {};
      try {
        challenge = parseWwwAuthenticate(context.response.headers.get("www-authenticate"));
      } catch {
        // Discovery still works without the challenge header.
      }
      if (challenge.error === "insufficient_scope") throw new McpOAuthAuthorizationRequiredError();
      await refresh(context.token, challenge, context.fetch as typeof fetch);
    },
    settled: async () => {
      await refreshing?.catch(() => undefined);
    },
  };
}

function resolveEntryValues(config: McpServerConfig): { headers?: Record<string, string>; env?: Record<string, string> } {
  return {
    headers: resolveValues("headers" in config ? config.headers : undefined),
    env: resolveValues("env" in config ? config.env : undefined),
  };
}

function createTransport(entry: McpServerEntry, authProvider: AuthProvider | undefined): McpTransport {
  const { config } = entry;
  if ("url" in config) {
    const { headers } = resolveEntryValues(config);
    return new StreamableHttpTransport({
      url: config.url,
      headers,
      openGetStream: false,
      authProvider,
    });
  }
  if (!config.command?.trim()) {
    throw new McpServiceError("E_INVALID_PARAMS", `MCP server "${entry.name}" has no command`);
  }
  const { env } = resolveEntryValues(config);
  return new StdioTransport({
    command: config.command,
    args: config.args,
    env,
    cwd: config.cwd,
  });
}

// ---------------------------------------------------------------------------
// Connection pool
// ---------------------------------------------------------------------------

interface PooledConnection {
  key: string;
  client: McpClient;
  idleTimer: NodeJS.Timeout | null;
  auth: (AuthProvider & { settled(): Promise<void> }) | null;
}

const pool = new Map<string, PooledConnection>();

function fingerprint(entry: McpServerEntry): string {
  return `${entry.scope ?? ""}:${entry.name}:${JSON.stringify(entry.config)}`;
}

function scheduleIdleClose(pooled: PooledConnection): void {
  if (pooled.idleTimer) clearTimeout(pooled.idleTimer);
  pooled.idleTimer = setTimeout(() => {
    if (pool.get(pooled.key) === pooled) pool.delete(pooled.key);
    void pooled.auth?.settled().catch(() => undefined);
    void pooled.client.close().catch(() => undefined);
  }, POOL_IDLE_MS);
  pooled.idleTimer.unref?.();
}

async function getPooledClient(entry: McpServerEntry): Promise<PooledConnection> {
  const key = fingerprint(entry);
  const existing = pool.get(key);
  if (existing && existing.client.connectionState === "connected") {
    scheduleIdleClose(existing);
    return existing;
  }
  if (existing) {
    pool.delete(key);
    if (existing.idleTimer) clearTimeout(existing.idleTimer);
    await existing.client.close().catch(() => undefined);
  }

  const url = serverUrlOf(entry);
  const auth =
    url && usesOAuth(entry.config)
      ? createStoredAuthProvider({
          serverName: entry.name,
          serverUrl: url,
          settings: oauthSettings(entry.config),
          store: authStore(),
        })
      : null;
  const client = new McpClient({ ...CLIENT_INFO, requestTimeoutMs: REQUEST_TIMEOUT_MS });
  const transport = createTransport(entry, auth ?? undefined);
  const pooled: PooledConnection = { key, client, idleTimer: null, auth };
  pool.set(key, pooled);
  try {
    await client.connect(transport);
  } catch (error) {
    pool.delete(key);
    await client.close().catch(() => undefined);
    throw error;
  }
  scheduleIdleClose(pooled);
  return pooled;
}

/** Drop every cached management connection (host shutdown / config change). */
export async function closeAllMcpClients(): Promise<void> {
  const connections = [...pool.values()];
  pool.clear();
  const logins = [...pendingLogins.values()];
  pendingLogins.clear();
  await Promise.all(
    logins.map(async (pending) => {
      pending.record.status = "cancelled";
      pending.record.finishedAt = Date.now();
      pending.abort.abort();
      await pending.callback.close().catch(() => undefined);
    }),
  );
  await Promise.all(
    connections.map(async (pooled) => {
      if (pooled.idleTimer) clearTimeout(pooled.idleTimer);
      await pooled.auth?.settled().catch(() => undefined);
      await pooled.client.close().catch(() => undefined);
    }),
  );
}

/** Config changed for this server: the next call reconnects with the stored tokens. */
export async function invalidateMcpServer(serverName?: string): Promise<void> {
  const stale = [...pool.entries()].filter(([, pooled]) => !serverName || pooled.key.includes(`:${serverName}:`));
  for (const [key, pooled] of stale) {
    pool.delete(key);
    if (pooled.idleTimer) clearTimeout(pooled.idleTimer);
    await pooled.client.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function isAuthRequired(error: unknown): boolean {
  if (error instanceof McpOAuthAuthorizationRequiredError) return true;
  if (error instanceof McpAuthRequiredError) return true;
  if (error instanceof McpError) {
    return /401|unauthori[sz]ed|authorization required|sign.?in/i.test(error.message);
  }
  return error instanceof Error && /401|unauthori[sz]ed|authorization required|sign.?in/i.test(error.message);
}

/** Public probe for the host dispatcher so it can map auth failures to MCP_AUTH_REQUIRED. */
export function isMcpAuthRequiredError(error: unknown): boolean {
  return isAuthRequired(error);
}

function isMethodNotFound(error: unknown): boolean {
  return error instanceof McpError && error.code === -32601;
}

function summarizeTool(tool: McpTool): McpToolSummary {
  return { name: tool.name, ...(tool.description ? { description: tool.description } : {}) };
}

function summarizeResource(resource: {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
}): McpResourceSummary {
  return {
    uri: resource.uri,
    ...(resource.name ? { name: resource.name } : {}),
    ...(resource.title ? { title: resource.title } : {}),
    ...(resource.description ? { description: resource.description } : {}),
    ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
    ...(resource.size !== undefined ? { size: resource.size } : {}),
  };
}

function summarizeTemplate(template: {
  uriTemplate: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
}): McpResourceTemplateSummary {
  return {
    uriTemplate: template.uriTemplate,
    ...(template.name ? { name: template.name } : {}),
    ...(template.title ? { title: template.title } : {}),
    ...(template.description ? { description: template.description } : {}),
    ...(template.mimeType ? { mimeType: template.mimeType } : {}),
  };
}

/**
 * List resources when the server advertises the capability. `lenient` probes
 * treat a broken resource listing as "no resources" so a connection test never
 * fails over an optional feature.
 */
async function listResourcesSafe(client: McpClient, lenient: boolean): Promise<{
  resources: McpResourceSummary[];
  resourceTemplates: McpResourceTemplateSummary[];
}> {
  if (!client.serverCapabilities?.resources) return { resources: [], resourceTemplates: [] };
  try {
    const resources = await client.listResources();
    const templates = await client.listResourceTemplates();
    return {
      resources: resources.map(summarizeResource),
      resourceTemplates: templates.map(summarizeTemplate),
    };
  } catch (error) {
    if (lenient || isMethodNotFound(error)) return { resources: [], resourceTemplates: [] };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Probe / resources
// ---------------------------------------------------------------------------

function adhocEntry(connection: McpConnectionConfig): McpServerEntry {
  const transport = connection.transport ?? (connection.url ? "http" : "stdio");
  if (transport === "sse") {
    throw new McpServiceError("E_INVALID_PARAMS", "Legacy SSE is not supported; use Streamable HTTP.");
  }
  if (transport === "http") {
    if (!connection.url || !URL.canParse(connection.url)) {
      throw new McpServiceError("E_INVALID_PARAMS", "A valid HTTP endpoint URL is required");
    }
    const config = {
      type: "http",
      url: connection.url,
      headers: connection.headers,
      enabled: true,
    } as McpServerConfig;
    return { name: "probe", config, source: "adhoc" };
  }
  if (!connection.command?.trim()) {
    throw new McpServiceError("E_INVALID_PARAMS", "A command is required for stdio transport");
  }
  const config = {
    type: "stdio",
    command: connection.command,
    args: connection.args,
    env: connection.env,
    cwd: connection.cwd,
    enabled: true,
  } as McpServerConfig;
  return { name: "probe", config, source: "adhoc" };
}

async function probeEntry(entry: McpServerEntry): Promise<McpConnectionReport> {
  const startedAt = Date.now();
  try {
    const pooled = await getPooledClient(entry);
    const tools = await pooled.client.listTools();
    const { resources, resourceTemplates } = await listResourcesSafe(pooled.client, true);
    const instructions = pooled.client.instructions;
    return {
      ok: true,
      elapsedMs: Date.now() - startedAt,
      authRequired: false,
      toolsCount: tools.length,
      tools: tools.map(summarizeTool),
      resources,
      resourceTemplates,
      ...(instructions ? { instructions } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - startedAt,
      authRequired: isAuthRequired(error),
      toolsCount: 0,
      tools: [],
      resources: [],
      resourceTemplates: [],
    };
  }
}

export interface ProbeMcpRequest {
  cwd?: string;
  serverId?: string;
  scope?: McpScope;
  connection?: McpConnectionConfig;
}

export async function probeMcpServer(request: ProbeMcpRequest): Promise<McpConnectionReport> {
  if (request.serverId) {
    return probeEntry(resolveServer({ cwd: request.cwd, serverId: request.serverId, scope: request.scope }));
  }
  if (!request.connection) {
    throw new McpServiceError("E_INVALID_PARAMS", "serverId or connection is required");
  }
  return probeEntry(adhocEntry(request.connection));
}

/** Probe an unsaved connection form. Kept as the single entry point for the route test. */
export async function probeMcpConnection(connection: McpConnectionConfig): Promise<McpConnectionReport> {
  return probeEntry(adhocEntry(connection));
}

export async function listMcpResources(
  ref: { cwd?: string; serverId: string; scope?: McpScope },
): Promise<{ toolsCount: number; resources: McpResourceSummary[]; resourceTemplates: McpResourceTemplateSummary[] }> {
  const entry = resolveServer(ref);
  const pooled = await getPooledClient(entry);
  const tools = await pooled.client.listTools().catch((error: unknown) => {
    if (isMethodNotFound(error)) return [];
    throw error;
  });
  const { resources, resourceTemplates } = await listResourcesSafe(pooled.client, false);
  return { toolsCount: tools.length, resources, resourceTemplates };
}

export async function readMcpResource(
  ref: { cwd?: string; serverId: string; scope?: McpScope; uri: string },
): Promise<McpResourceReadResult> {
  const uri = ref.uri?.trim();
  if (!uri) throw new McpServiceError("E_INVALID_PARAMS", "uri is required");
  const entry = resolveServer(ref);
  const pooled = await getPooledClient(entry);
  const result = await pooled.client.readResource(uri);
  let truncated = false;
  const contents: McpResourceContent[] = result.contents.map((content) => {
    if ("text" in content) {
      let text = content.text;
      if (text.length > MAX_RESOURCE_TEXT) {
        text = text.slice(0, MAX_RESOURCE_TEXT);
        truncated = true;
      }
      return {
        uri: content.uri,
        ...(content.mimeType ? { mimeType: content.mimeType } : {}),
        text,
      };
    }
    return {
      uri: content.uri,
      ...(content.mimeType ? { mimeType: content.mimeType } : {}),
      blobBase64: content.blob,
    };
  });
  return { contents, truncated };
}

// ---------------------------------------------------------------------------
// OAuth sign-in / refresh / sign-out
// ---------------------------------------------------------------------------

interface PendingLogin {
  record: McpPendingLogin;
  abort: AbortController;
  callback: OAuthCallbackServer;
}

const pendingLogins = new Map<string, PendingLogin>();

function prunePendingLogins(): void {
  const now = Date.now();
  for (const [loginId, pending] of pendingLogins) {
    if (pending.record.finishedAt && now - pending.record.finishedAt > 5 * 60_000) {
      pendingLogins.delete(loginId);
    }
  }
}

export function pendingLoginFor(serverId: string): McpPendingLogin | undefined {
  let latest: McpPendingLogin | undefined;
  for (const pending of pendingLogins.values()) {
    if (pending.record.serverId !== serverId) continue;
    if (!latest || pending.record.startedAt >= latest.startedAt) latest = pending.record;
  }
  return latest;
}

export function getLoginStatus(loginId: string): McpPendingLogin | null {
  return pendingLogins.get(loginId)?.record ?? null;
}

export function authStateOf(entry: McpServerEntry): McpAuthState {
  const url = serverUrlOf(entry);
  const oauth = Boolean(url) && usesOAuth(entry.config);
  const state = url ? authStore().load(entry.name, url) : undefined;
  const tokens = state?.tokens;
  const login = pendingLoginFor(entry.name);
  return {
    oauth,
    authenticated: Boolean(tokens?.access_token),
    hasClient: Boolean(state?.clientInformation),
    hasRefreshToken: Boolean(tokens?.refresh_token),
    ...(state?.tokensExpireAt !== undefined ? { expiresAt: state.tokensExpireAt } : {}),
    ...(tokens?.scope ? { scope: tokens.scope } : {}),
    ...(login ? { login } : {}),
  };
}

export function mcpAuthStatus(ref: { cwd?: string; serverId: string; scope?: McpScope }): McpAuthState {
  return authStateOf(resolveServer(ref));
}

export async function loginMcpServer(
  ref: { cwd?: string; serverId: string; scope?: McpScope },
): Promise<{ loginId: string; authorizationUrl: string }> {
  const entry = resolveServer(ref);
  const serverUrl = serverUrlOf(entry);
  if (!serverUrl) throw new McpServiceError("E_INVALID_PARAMS", "OAuth sign-in requires an HTTP MCP endpoint");
  if (!usesOAuth(entry.config)) {
    throw new McpServiceError("E_INVALID_PARAMS", "This server authenticates with a header, not OAuth");
  }

  const settings = oauthSettings(entry.config);
  const target = callbackTarget(settings);
  prunePendingLogins();

  const callback = await OAuthCallbackServer.listen({
    host: target.host,
    redirectHost: target.redirectHost,
    path: target.path,
    port: target.port,
    timeoutMs: LOGIN_TIMEOUT_MS,
  });
  const redirectUrl = target.fixedRedirectUrl ?? callback.redirectUrl;
  const store = authStore();
  const abort = new AbortController();
  const loginId = randomUUID();
  const loginScope: McpScope | undefined =
    entry.override || entry.scope === "project" ? "project" : entry.scope === "global" ? "global" : undefined;
  const record: McpPendingLogin = {
    loginId,
    serverId: entry.name,
    ...(loginScope ? { scope: loginScope } : {}),
    status: "pending",
    startedAt: Date.now(),
  };
  const pending: PendingLogin = { record, abort, callback };
  pendingLogins.set(loginId, pending);

  try {
    // Start from a clean pending state: a fresh `state` parameter every sign-in.
    const stored = store.load(entry.name, serverUrl);
    if (stored) {
      const next = { ...stored };
      delete next.oauthState;
      const registered = registeredRedirectUrls(stored.clientInformation)[0];
      const keepClient = Boolean(settings.clientId) || registered === redirectUrl;
      if (!keepClient) {
        delete next.clientInformation;
        delete next.tokens;
        delete next.tokensExpireAt;
      }
      store.save(entry.name, serverUrl, next);
    }

    let authorizationUrl: URL | undefined;
    const provider = createOAuthProvider({
      serverName: entry.name,
      serverUrl,
      settings,
      redirectUrl,
      store,
      onRedirect: (url) => {
        authorizationUrl = url;
      },
    });
    const flow = {
      serverUrl,
      fetch: timedFetch(),
      signal: abort.signal,
      scope: settings.scope,
      authorizationServerMetadataUrl: settings.authServerMetadataUrl,
    };
    const result = await authorizeMcp(provider, { ...flow, skipRefresh: true });
    if (result === "AUTHORIZED") {
      record.status = "authorized";
      record.finishedAt = Date.now();
      await callback.close().catch(() => undefined);
      return { loginId, authorizationUrl: redirectUrl };
    }
    if (!authorizationUrl) throw new Error("OAuth flow did not produce an authorization URL");
    const authorizationUrlString = authorizationUrl.href;
    record.authorizationUrl = authorizationUrlString;

    const state = await provider.state();
    const redirectPath = new URL(authorizationUrl.searchParams.get("redirect_uri") ?? redirectUrl).pathname;

    void (async () => {
      try {
        const response = await callback.waitForCallback(state, redirectPath);
        await authorizeMcp(provider, { ...flow, authorizationCode: response.code, iss: response.iss });
        record.status = "authorized";
        await invalidateMcpServer(entry.name);
      } catch (error) {
        record.status = abort.signal.aborted ? "cancelled" : "failed";
        record.message = error instanceof Error ? error.message : String(error);
      } finally {
        record.finishedAt = Date.now();
        await callback.close().catch(() => undefined);
      }
    })();

    return { loginId, authorizationUrl: authorizationUrlString };
  } catch (error) {
    record.status = abort.signal.aborted ? "cancelled" : "failed";
    record.message = error instanceof Error ? error.message : String(error);
    record.finishedAt = Date.now();
    await callback.close().catch(() => undefined);
    throw error;
  }
}

export async function cancelMcpLogin(loginId: string): Promise<boolean> {
  const pending = pendingLogins.get(loginId);
  if (!pending) return false;
  pending.record.status = "cancelled";
  pending.record.finishedAt = Date.now();
  pending.abort.abort();
  await pending.callback.close().catch(() => undefined);
  return true;
}

export async function logoutMcpServer(ref: { cwd?: string; serverId: string; scope?: McpScope }): Promise<boolean> {
  const entry = resolveServer(ref);
  const serverUrl = serverUrlOf(entry);
  if (!serverUrl) return false;
  await invalidateMcpServer(entry.name);
  return authStore().remove(entry.name, serverUrl);
}

export async function refreshMcpAuth(ref: { cwd?: string; serverId: string; scope?: McpScope }): Promise<McpAuthState> {
  const entry = resolveServer(ref);
  const serverUrl = serverUrlOf(entry);
  if (!serverUrl) throw new McpServiceError("E_INVALID_PARAMS", "Credential refresh requires an HTTP MCP endpoint");
  if (!usesOAuth(entry.config)) {
    throw new McpServiceError("E_INVALID_PARAMS", "This server authenticates with a header, not OAuth");
  }
  const settings = oauthSettings(entry.config);
  const store = authStore();
  const stored = store.load(entry.name, serverUrl);
  if (!stored?.tokens?.refresh_token) {
    throw new McpServiceError("MCP_AUTH_REQUIRED", "No stored refresh token; sign in first.");
  }
  const provider = createOAuthProvider({
    serverName: entry.name,
    serverUrl,
    settings,
    redirectUrl:
      callbackTarget(settings).fixedRedirectUrl ??
      registeredRedirectUrls(stored.clientInformation)[0] ??
      settings.callbackUrl ??
      DEFAULT_CALLBACK_URL,
    store,
  });
  const result = await authorizeMcp(provider, {
    serverUrl,
    fetch: timedFetch(),
    scope: settings.scope,
    authorizationServerMetadataUrl: settings.authServerMetadataUrl,
  });
  if (result === "REDIRECT") {
    throw new McpServiceError("MCP_AUTH_REQUIRED", "The refresh token was rejected; sign in again.");
  }
  await invalidateMcpServer(entry.name);
  return authStateOf(entry);
}
