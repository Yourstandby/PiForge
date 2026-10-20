import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  McpServiceError,
  listMcpResources,
  logoutMcpServer,
  mcpAuthStatus,
  probeMcpConnection,
  probeMcpServer,
  readMcpResource,
  resolveServer,
} from "./mcp-service.ts";
import { saveMcpServer } from "../lib/mcp-config.ts";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

/** Point pi's agent dir at a temp directory for the duration of one test. */
function useAgentDir(dir: string): () => void {
  const previous = process.env[AGENT_DIR_ENV];
  process.env[AGENT_DIR_ENV] = dir;
  return () => {
    if (previous === undefined) delete process.env[AGENT_DIR_ENV];
    else process.env[AGENT_DIR_ENV] = previous;
  };
}

interface Fixture {
  url: string;
  methods: string[];
  close(): Promise<void>;
}

/** Minimal MCP server: initialize, tools/list, resources/list, templates/list, resources/read. */
async function startFixture(options: { requireAuth?: boolean } = {}): Promise<Fixture> {
  const methods: string[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (options.requireAuth && request.headers.authorization !== "Bearer fixture-token") {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const message = JSON.parse(body);
    methods.push(message.method);
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const result = (() => {
      switch (message.method) {
        case "initialize":
          return {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: "http-fixture", version: "1" },
          };
        case "tools/list":
          return { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }] };
        case "resources/list":
          return { resources: [{ uri: "fixture://notes", name: "notes", mimeType: "text/plain" }] };
        case "resources/templates/list":
          return { resourceTemplates: [{ uriTemplate: "fixture://notes/{id}", name: "note" }] };
        case "resources/read":
          return { contents: [{ uri: message.params.uri, mimeType: "text/plain", text: "hello resource" }] };
        default:
          return {};
      }
    })();
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    methods,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

test("HTTP probe discovers tools, resources and templates", { timeout: 20000 }, async () => {
  const fixture = await startFixture();
  try {
    const report = await probeMcpConnection({ transport: "http", url: fixture.url });
    assert.equal(report.ok, true);
    assert.equal(report.toolsCount, 1);
    assert.equal(report.tools[0].name, "echo");
    assert.equal(report.resources[0].uri, "fixture://notes");
    assert.equal(report.resourceTemplates[0].uriTemplate, "fixture://notes/{id}");
    assert.ok(fixture.methods.includes("initialize"));
    assert.ok(fixture.methods.includes("tools/list"));
    assert.ok(fixture.methods.includes("resources/list"));
  } finally {
    await fixture.close();
  }
});

test("saved server resources list and read through the host service", { timeout: 20000 }, async () => {
  const fixture = await startFixture();
  const dir = mkdtempSync(join(tmpdir(), "pi-mcp-service-"));
  const restore = useAgentDir(join(dir, "agent"));
  try {
    saveMcpServer("global", { id: "fixture", transport: "http", url: fixture.url }, undefined, { agentDir: join(dir, "agent") });
    const listed = await listMcpResources({ serverId: "fixture", cwd: dir });
    assert.equal(listed.toolsCount, 1);
    assert.deepEqual(listed.resources.map((resource) => resource.uri), ["fixture://notes"]);
    assert.equal(listed.resourceTemplates.length, 1);

    const read = await readMcpResource({ serverId: "fixture", cwd: dir, uri: "fixture://notes" });
    assert.equal(read.truncated, false);
    assert.equal(read.contents[0].text, "hello resource");

    const probe = await probeMcpServer({ serverId: "fixture", cwd: dir });
    assert.equal(probe.ok, true);
  } finally {
    await fixture.close();
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("untrusted project servers are refused before a transport is created", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-mcp-untrusted-"));
  const restore = useAgentDir(join(dir, "agent"));
  try {
    const project = join(dir, "project");
    mkdirSync(join(project, ".pi"), { recursive: true });
    writeFileSync(
      join(project, ".pi", "mcp.json"),
      JSON.stringify({ mcpServers: { local: { command: process.execPath, args: ["-v"] } } }),
    );
    assert.throws(
      () => resolveServer({ serverId: "local", cwd: project }),
      (error: unknown) => error instanceof McpServiceError && error.code === "MCP_PROJECT_UNTRUSTED",
    );
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OAuth credentials are read from pi's mcp-auth.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-mcp-auth-"));
  const restore = useAgentDir(join(dir, "agent"));
  try {
    const agentDir = join(dir, "agent");
    const url = "https://mcp.example.com/mcp";
    saveMcpServer("global", { id: "auth-test", transport: "http", url }, undefined, { agentDir });
    mkdirSync(agentDir, { recursive: true });
    const file = join(agentDir, "mcp-auth.json");
    writeFileSync(
      file,
      JSON.stringify({
        "mcp__auth_test|https://mcp.example.com/mcp": {
          serverUrl: url,
          clientInformation: { client_id: "client-1" },
          tokens: { access_token: "access", token_type: "Bearer", refresh_token: "refresh", scope: "read" },
          tokensExpireAt: 2_000_000_000_000,
        },
      }),
    );

    const status = mcpAuthStatus({ serverId: "auth-test", cwd: dir });
    assert.equal(status.oauth, true);
    assert.equal(status.authenticated, true);
    assert.equal(status.hasClient, true);
    assert.equal(status.hasRefreshToken, true);
    assert.equal(status.scope, "read");
    assert.equal(status.expiresAt, 2_000_000_000_000);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("logout removes stored credentials", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-mcp-logout-"));
  const restore = useAgentDir(join(dir, "agent"));
  try {
    const agentDir = join(dir, "agent");
    const url = "https://mcp.example.com/mcp";
    saveMcpServer("global", { id: "logout-test", transport: "http", url }, undefined, { agentDir });
    mkdirSync(agentDir, { recursive: true });
    const file = join(agentDir, "mcp-auth.json");
    writeFileSync(file, JSON.stringify({ "mcp__logout_test|https://mcp.example.com/mcp": { serverUrl: url, tokens: { access_token: "a", token_type: "Bearer" } } }));
    assert.equal(await logoutMcpServer({ serverId: "logout-test", cwd: dir }), true);
    const stored = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    assert.equal(Object.keys(stored).length, 0);
    assert.equal(mcpAuthStatus({ serverId: "logout-test", cwd: dir }).authenticated, false);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});
