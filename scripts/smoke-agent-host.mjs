#!/usr/bin/env node
/**
 * End-to-end smoke test for the Agent Host skeleton.
 *
 * Spawns the compiled host with a throwaway endpoint + token, then verifies:
 *   1. hello/token handshake -> hello_ok
 *   2. host.health responds
 *   3. unknown methods / wrong tokens are rejected
 *   4. process subscriptions, start/stop, logs and cascade cleanup
 *   5. terminal subscriptions, shell block lifecycle and clearing
 *   6. host.shutdown lets the process exit
 */
import { spawnNodeHost } from "./lib/host-spawn.mjs";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hostEntry = process.env.PIFORGE_HOST_ENTRY
  ? path.resolve(process.env.PIFORGE_HOST_ENTRY)
  : path.join(repoRoot, "agent-host", "dist", "agent-host", "index.js");
const TIMEOUT_MS = 20_000;

if (!existsSync(hostEntry)) {
  console.error(`agent-host smoke: missing ${hostEntry} (run npm run build:agent-host)`);
  process.exit(1);
}

function createEndpoint() {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\piforge-smoke-${randomBytes(8).toString("hex")}`;
  }
  const dir = path.join(tmpdir(), `piforge-smoke-${process.pid}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, "agent-host.sock");
}

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let output = "";
    const timer = setTimeout(() => finish(new Error("host did not report ready")), TIMEOUT_MS);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      if (output.includes("[agent-host] ready")) finish(null);
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.once("exit", (code) => {
      finish(new Error(`host exited before ready (code ${code})\n${output}`));
    });
    child.once("error", (error) => finish(error));
  });
}

function createClient(endpoint) {
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint);
    let buffer = "";
    const pending = [];
    const waiters = [];

    const deliver = (frame) => {
      if (frame.kind === "ping") {
        socket.write(`${JSON.stringify({ kind: "pong", nonce: frame.nonce })}\n`);
        return;
      }
      const waiter = waiters.shift();
      if (waiter) waiter(frame);
      else pending.push(frame);
    };

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) deliver(JSON.parse(line));
      }
    });
    socket.once("connect", () => {
      const next = () => {
        if (pending.length > 0) return Promise.resolve(pending.shift());
        return new Promise((resolveNext, rejectNext) => {
          const timer = setTimeout(() => rejectNext(new Error("timed out waiting for a frame")), TIMEOUT_MS);
          waiters.push((frame) => {
            clearTimeout(timer);
            resolveNext(frame);
          });
        });
      };
      resolve({
        socket,
        send(frame) {
          socket.write(`${JSON.stringify(frame)}\n`);
        },
        next,
        async waitFor(predicate) {
          for (;;) {
            const frame = await next();
            if (predicate(frame)) return frame;
          }
        },
      });
    });
    socket.once("error", reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await sleep(200);
  }
  return !isPidAlive(pid);
}

async function main() {
  const endpoint = createEndpoint();
  const token = randomBytes(32).toString("hex");
  const sandbox = mkdtempSync(path.join(tmpdir(), "piforge-smoke-mcp-"));
  const agentDir = path.join(sandbox, "agent");
  const fixturePath = path.join(sandbox, "mcp-fixture.mjs");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    fixturePath,
    `import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result = {};
  if (request.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "smoke-mcp", version: "1" } };
  if (request.method === "tools/list") result = { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }] };
  if (request.method === "resources/list") result = { resources: [{ uri: "smoke://note", name: "note", mimeType: "text/plain" }] };
  if (request.method === "resources/templates/list") result = { resourceTemplates: [{ uriTemplate: "smoke://note/{id}", name: "note-template" }] };
  if (request.method === "resources/read") result = { contents: [{ uri: request.params.uri, mimeType: "text/plain", text: "smoke-resource-body" }] };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
});`,
  );
  writeFileSync(
    path.join(agentDir, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        smoke: { command: process.execPath, args: [fixturePath], exposure: "deferred" },
      },
    }),
  );
  const child = spawnNodeHost({
    entry: hostEntry,
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PI_CODING_AGENT_DIR: agentDir,
      PIFORGE_AGENT_ENDPOINT: endpoint,
      PIFORGE_AGENT_TOKEN: token,
    },
  });
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });

  try {
    await waitForReady(child);

    const client = await createClient(endpoint);
    client.send({
      kind: "hello",
      protocolVersion: 1,
      token,
      client: { pid: process.pid, role: "cli" },
    });
    const hello = await client.waitFor((frame) => frame.kind === "hello_ok" || frame.kind === "hello_error");
    assert.equal(hello.kind, "hello_ok", "expected hello_ok");
    assert.equal(hello.protocolVersion, 1);
    assert.equal(hello.hostPid, child.pid);

    client.send({ kind: "req", id: 1, method: "host.health", params: {} });
    const health = await client.waitFor((frame) => frame.kind === "res" && frame.id === 1);
    assert.equal(health.ok, true);
    assert.equal(health.result.ok, true);
    assert.equal(health.result.sessions, 0);
    // ≥1 而不是 =1：Host 会为自己预热一个内部 api 客户端（role=next-server），
    // 它同样计入 handshaked。本脚本真正关心的是"我们这次 cli 握手成功了" —— 已由
    // hello.hostPid 与后续 RPC 覆盖，所以这里只要求至少有一个客户端完成握手。
    assert.ok(health.result.handshaked >= 1, `expected >=1 handshaked client, got ${health.result.handshaked}`);

    client.send({ kind: "req", id: 2, method: "does.not.exist", params: {} });
    const unknown = await client.waitFor((frame) => frame.kind === "res" && frame.id === 2);
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error.code, "E_UNKNOWN_METHOD");

    // ---- watchdog（无进展看门狗：纯程序层、只读）----
    client.send({ kind: "req", id: 91, method: "watchdog.status", params: {} });
    const watchdog = await client.waitFor((frame) => frame.kind === "res" && frame.id === 91);
    assert.equal(watchdog.ok, true, JSON.stringify(watchdog.error));
    assert.equal(watchdog.result.enabled, true);
    // 默认阈值 20s（面板可在 15/30/60/90 秒间运行期切换）。
    assert.equal(watchdog.result.config.stallMs, 20_000);
    assert.deepEqual(watchdog.result.tasks, []);
    assert.deepEqual(watchdog.result.notices, []);

    client.send({ kind: "req", id: 92, method: "watchdog.task", params: { taskId: "nope" } });
    const singleTask = await client.waitFor((frame) => frame.kind === "res" && frame.id === 92);
    assert.equal(singleTask.ok, true, JSON.stringify(singleTask.error));
    assert.equal(singleTask.result.task, null);

    // ---- 人工介入：参数校验 + 会话不存在时的拒绝（不能静默成功）----
    client.send({ kind: "req", id: 93, method: "agent.intervene", params: { sessionId: "ghost", actionType: "abort" } });
    const badAction = await client.waitFor((frame) => frame.kind === "res" && frame.id === 93);
    assert.equal(badAction.ok, false);
    assert.equal(badAction.error.code, "E_INVALID_PARAMS");

    client.send({ kind: "req", id: 94, method: "agent.intervene", params: { sessionId: "ghost", actionType: "skip" } });
    const missingSession = await client.waitFor((frame) => frame.kind === "res" && frame.id === 94);
    assert.equal(missingSession.ok, false);
    assert.equal(missingSession.error.code, "SESSION_NOT_FOUND");

    // ---- subscriptions ----
    client.send({ kind: "req", id: 3, method: "host.subscribe", params: { topics: ["processes", "terminal", "subagents"] } });
    const subscribe = await client.waitFor((frame) => frame.kind === "res" && frame.id === 3);
    assert.equal(subscribe.ok, true);
    assert.ok(subscribe.result.subscriptionId);

    const processSnapshot = await client.waitFor(
      (frame) => frame.kind === "evt" && frame.topic === "processes.changed",
    );
    assert.deepEqual(processSnapshot.payload.processes, []);
    const terminalSnapshot = await client.waitFor(
      (frame) => frame.kind === "evt" && frame.topic === "terminal.changed",
    );
    assert.deepEqual(terminalSnapshot.payload.blocks, []);
    const subagentSnapshot = await client.waitFor(
      (frame) => frame.kind === "evt" && frame.topic === "subagents.changed",
    );
    assert.deepEqual(subagentSnapshot.payload.agents, []);

    // ---- terminal lifecycle ----
    for (const [id, method, params] of [
      [4, "terminal.shellStart", { id: "smoke-term", command: "echo hi", cwd: repoRoot }],
      [5, "terminal.shellUpdate", { id: "smoke-term", text: "partial" }],
      [6, "terminal.shellFinish", { id: "smoke-term", text: "final output", status: "ok" }],
    ]) {
      client.send({ kind: "req", id, method, params });
      const response = await client.waitFor((frame) => frame.kind === "res" && frame.id === id);
      assert.equal(response.ok, true, `${method} failed`);
    }
    const terminalEvent = await client.waitFor(
      (frame) =>
        frame.kind === "evt" &&
        frame.topic === "terminal.changed" &&
        frame.payload.blocks?.some((block) => block.id === "smoke-term" && block.text === "final output"),
    );
    assert.equal(terminalEvent.payload.blocks[0].status, "ok");

    // ---- managed process lifecycle ----
    client.send({
      kind: "req",
      id: 7,
      method: "processes.start",
      params: {
        cwd: repoRoot,
        command: "node -e \"console.log('ready in 1ms (smoke-process-ready)'); setInterval(() => {}, 1000)\"",
        name: "smoke-process",
        owner: "agent",
      },
    });
    const started = await client.waitFor((frame) => frame.kind === "res" && frame.id === 7);
    assert.equal(started.ok, true);
    const processId = started.result.process.id;
    const processPid = started.result.process.pid;
    assert.ok(processId);
    assert.ok(processPid);
    assert.equal(started.result.process.owner, "agent");
    assert.ok(["starting", "running"].includes(started.result.process.status));

    const processEvent = await client.waitFor(
      (frame) =>
        frame.kind === "evt" &&
        frame.topic === "processes.changed" &&
        frame.payload.processes?.some(
          (entry) => entry.id === processId && entry.logs.some((line) => line.includes("smoke-process-ready")),
        ),
    );
    const tracked = processEvent.payload.processes.find((entry) => entry.id === processId);
    assert.equal(tracked.status, "running");
    assert.equal(tracked.owner, "agent");
    assert.equal(tracked.readiness, "ready");
    assert.equal(tracked.cleanup, null);
    assert.equal(typeof tracked.durationMs, "number");

    client.send({ kind: "req", id: 8, method: "processes.stop", params: { id: processId } });
    const stopped = await client.waitFor((frame) => frame.kind === "res" && frame.id === 8);
    assert.equal(stopped.ok, true);
    assert.equal(stopped.result.ok, true);
    const stoppedEvent = await client.waitFor(
      (frame) =>
        frame.kind === "evt" &&
        frame.topic === "processes.changed" &&
        frame.payload.processes?.some(
          (entry) => entry.id === processId && entry.status === "stopped",
        ),
    );
    const stoppedView = stoppedEvent.payload.processes.find((entry) => entry.id === processId);
    assert.equal(stoppedView.exitReason, "stopped");
    assert.equal(stoppedView.cleanup?.ok, true);
    assert.ok(await waitForPidExit(processPid), "stopped process should no longer be alive");

    // force-stop is a separate RPC and must report the same lifecycle fields
    client.send({
      kind: "req",
      id: 34,
      method: "processes.start",
      params: {
        cwd: repoRoot,
        command: "node -e \"setInterval(() => {}, 1000)\"",
        name: "smoke-force-stop",
        owner: "agent",
      },
    });
    const forceStarted = await client.waitFor((frame) => frame.kind === "res" && frame.id === 34);
    assert.equal(forceStarted.ok, true, JSON.stringify(forceStarted.error));
    const forceId = forceStarted.result.process.id;
    await client.waitFor(
      (frame) =>
        frame.kind === "evt" &&
        frame.topic === "processes.changed" &&
        frame.payload.processes?.some((entry) => entry.id === forceId && entry.status === "running"),
    );
    client.send({ kind: "req", id: 35, method: "processes.forceStop", params: { id: forceId } });
    const forceStopped = await client.waitFor((frame) => frame.kind === "res" && frame.id === 35);
    assert.equal(forceStopped.ok, true, JSON.stringify(forceStopped.error));
    assert.equal(forceStopped.result.ok, true);

    // ---- MCP management (connections stay in the host) ----
    client.send({ kind: "req", id: 11, method: "mcp.probe", params: { serverId: "smoke", cwd: repoRoot } });
    const mcpProbe = await client.waitFor((frame) => frame.kind === "res" && frame.id === 11);
    assert.equal(mcpProbe.ok, true, JSON.stringify(mcpProbe.error));
    assert.equal(mcpProbe.result.ok, true, mcpProbe.result.message);
    assert.equal(mcpProbe.result.toolsCount, 1);
    assert.equal(mcpProbe.result.resources.length, 1);
    assert.equal(mcpProbe.result.resourceTemplates.length, 1);

    client.send({ kind: "req", id: 12, method: "mcp.resources", params: { serverId: "smoke", cwd: repoRoot } });
    const mcpResources = await client.waitFor((frame) => frame.kind === "res" && frame.id === 12);
    assert.equal(mcpResources.ok, true, JSON.stringify(mcpResources.error));
    assert.equal(mcpResources.result.resources[0].uri, "smoke://note");

    client.send({ kind: "req", id: 13, method: "mcp.readResource", params: { serverId: "smoke", cwd: repoRoot, uri: "smoke://note" } });
    const mcpRead = await client.waitFor((frame) => frame.kind === "res" && frame.id === 13);
    assert.equal(mcpRead.ok, true, JSON.stringify(mcpRead.error));
    assert.equal(mcpRead.result.contents[0].text, "smoke-resource-body");
    assert.equal(mcpRead.result.truncated, false);

    client.send({ kind: "req", id: 14, method: "mcp.authStatus", params: { serverId: "smoke", cwd: repoRoot } });
    const mcpAuth = await client.waitFor((frame) => frame.kind === "res" && frame.id === 14);
    assert.equal(mcpAuth.ok, true, JSON.stringify(mcpAuth.error));
    assert.equal(mcpAuth.result.oauth, false);
    assert.equal(mcpAuth.result.authenticated, false);

    client.send({ kind: "req", id: 15, method: "mcp.login", params: { serverId: "smoke", cwd: repoRoot } });
    const mcpLogin = await client.waitFor((frame) => frame.kind === "res" && frame.id === 15);
    assert.equal(mcpLogin.ok, false);
    assert.equal(mcpLogin.error.code, "E_INVALID_PARAMS");

    client.send({ kind: "req", id: 16, method: "mcp.probe", params: { serverId: "missing", cwd: repoRoot } });
    const mcpMissing = await client.waitFor((frame) => frame.kind === "res" && frame.id === 16);
    assert.equal(mcpMissing.ok, false);
    assert.equal(mcpMissing.error.code, "MCP_SERVER_NOT_FOUND");

    // ---- auxiliary models (image generation / decisions) ----
    client.send({ kind: "req", id: 17, method: "models.auxConfig", params: {} });
    const auxEmpty = await client.waitFor((frame) => frame.kind === "res" && frame.id === 17);
    assert.equal(auxEmpty.ok, true, JSON.stringify(auxEmpty.error));
    assert.deepEqual(auxEmpty.result, { image: null, decision: null });

    client.send({ kind: "req", id: 18, method: "models.auxCatalogue", params: {} });
    const auxCatalogue = await client.waitFor((frame) => frame.kind === "res" && frame.id === 18);
    assert.equal(auxCatalogue.ok, true, JSON.stringify(auxCatalogue.error));
    assert.ok(Array.isArray(auxCatalogue.result.image));
    assert.ok(Array.isArray(auxCatalogue.result.classifier));

    client.send({
      kind: "req",
      id: 19,
      method: "models.setAuxConfig",
      params: { image: { provider: "openrouter", modelId: "black-forest-labs/flux.2-pro" } },
    });
    const auxSaved = await client.waitFor((frame) => frame.kind === "res" && frame.id === 19);
    assert.equal(auxSaved.ok, true, JSON.stringify(auxSaved.error));
    assert.equal(auxSaved.result.image.provider, "openrouter");

    client.send({ kind: "req", id: 20, method: "models.auxConfig", params: {} });
    const auxRead = await client.waitFor((frame) => frame.kind === "res" && frame.id === 20);
    assert.equal(auxRead.ok, true, JSON.stringify(auxRead.error));
    assert.equal(auxRead.result.image.modelId, "black-forest-labs/flux.2-pro");

    client.send({
      kind: "req",
      id: 21,
      method: "models.setAuxConfig",
      params: { image: { provider: "openrouter", modelId: "not-a-real-model" } },
    });
    const auxInvalid = await client.waitFor((frame) => frame.kind === "res" && frame.id === 21);
    assert.equal(auxInvalid.ok, false);
    assert.equal(auxInvalid.error.code, "E_INVALID_PARAMS");

    // Configured model, but no provider credentials in this sandbox: the call
    // reports the failure instead of throwing.
    client.send({ kind: "req", id: 22, method: "image.generate", params: { prompt: "a cat" } });
    const imageReport = await client.waitFor((frame) => frame.kind === "res" && frame.id === 22);
    assert.equal(imageReport.ok, true, JSON.stringify(imageReport.error));
    assert.equal(imageReport.result.ok, false);
    assert.match(imageReport.result.error, /not configured/i);

    client.send({
      kind: "req",
      id: 23,
      method: "decision.classify",
      params: {
        state: { diffLines: 12 },
        questions: [{ key: "risk", mode: "bool", instructions: "Is this change risky?" }],
      },
    });
    const decisionReport = await client.waitFor((frame) => frame.kind === "res" && frame.id === 23);
    assert.equal(decisionReport.ok, false);
    assert.equal(decisionReport.error.code, "AUX_MODEL_NOT_CONFIGURED");

    // ---- development environment probes (Host spawns, Next only proxies) ----
    client.send({ kind: "req", id: 24, method: "env.probe", params: { refresh: true } });
    const envReport = await client.waitFor((frame) => frame.kind === "res" && frame.id === 24);
    assert.equal(envReport.ok, true, JSON.stringify(envReport.error));
    assert.equal(envReport.result.platform, process.platform);
    assert.equal(envReport.result.hostNode, process.version);
    const nodeProbe = envReport.result.tools.find((tool) => tool.id === "node");
    assert.ok(nodeProbe, "expected a Node.js probe");
    assert.equal(nodeProbe.found, true);
    assert.match(nodeProbe.version ?? "", /\d+\.\d+/);

    // ---- persisted tool outputs (host-owned log files) ----
    const toolOutputDir = path.join(agentDir, "sessions", "tool-outputs", "smoke-session");
    mkdirSync(toolOutputDir, { recursive: true });
    const toolOutputFile = path.join(toolOutputDir, "call-1.log");
    writeFileSync(
      toolOutputFile,
      Array.from({ length: 300 }, (_, index) => `smoke line ${index + 1}`).join("\n"),
    );

    client.send({
      kind: "req",
      id: 25,
      method: "toolOutput.read",
      params: { file: toolOutputFile, offset: 200, limit: 200 },
    });
    const toolOutputPage = await client.waitFor((frame) => frame.kind === "res" && frame.id === 25);
    assert.equal(toolOutputPage.ok, true, JSON.stringify(toolOutputPage.error));
    assert.equal(toolOutputPage.result.totalLines, 300);
    assert.equal(toolOutputPage.result.hasMore, false);
    assert.match(toolOutputPage.result.text, /smoke line 201/);
    assert.match(toolOutputPage.result.text, /smoke line 300/);

    client.send({
      kind: "req",
      id: 26,
      method: "toolOutput.read",
      params: { file: path.join(sandbox, "outside.log") },
    });
    const toolOutputDenied = await client.waitFor((frame) => frame.kind === "res" && frame.id === 26);
    assert.equal(toolOutputDenied.ok, false);
    assert.equal(toolOutputDenied.error.code, "ACCESS_DENIED");

    // ---- sub-agents (Host-owned child sessions) ----
    client.send({ kind: "req", id: 32, method: "subagents.list", params: {} });
    const subagentsEmpty = await client.waitFor((frame) => frame.kind === "res" && frame.id === 32);
    assert.equal(subagentsEmpty.ok, true, JSON.stringify(subagentsEmpty.error));
    assert.deepEqual(subagentsEmpty.result.agents, []);

    client.send({ kind: "req", id: 33, method: "subagents.stop", params: { id: "missing-agent" } });
    const subagentStop = await client.waitFor((frame) => frame.kind === "res" && frame.id === 33);
    assert.equal(subagentStop.ok, true, JSON.stringify(subagentStop.error));
    assert.equal(subagentStop.result.ok, false);

    // ---- code-block apply (writes stay behind the host file policy) ----
    client.send({
      kind: "req",
      id: 27,
      method: "files.applyCode",
      params: { path: path.join(sandbox, "outside-apply.ts"), content: "x", mode: "overwrite" },
    });
    const applyDenied = await client.waitFor((frame) => frame.kind === "res" && frame.id === 27);
    assert.equal(applyDenied.ok, false);
    assert.equal(applyDenied.error.code, "ACCESS_DENIED");

    client.send({
      kind: "req",
      id: 28,
      method: "files.applyCode",
      params: { path: path.join(repoRoot, "AGENTS.md"), content: "x", mode: "replace" },
    });
    const applyInvalid = await client.waitFor((frame) => frame.kind === "res" && frame.id === 28);
    assert.equal(applyInvalid.ok, false);
    assert.equal(applyInvalid.error.code, "E_INVALID_PARAMS");

    // ---- session branches (JSONL tree already carries parentId) ----
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const branchSessionDir = path.join(agentDir, "sessions", "smoke-branch");
    mkdirSync(branchSessionDir, { recursive: true });
    const branchManager = SessionManager.create(sandbox, branchSessionDir);
    const branchUser1 = branchManager.appendMessage({
      role: "user",
      content: "smoke branch prompt",
      timestamp: Date.now(),
    });
    const branchAssistant = branchManager.appendMessage({
      role: "assistant",
      api: "openai-completions",
      provider: "smoke",
      model: "smoke",
      content: [{ type: "text", text: "smoke answer" }],
      stopReason: "stop",
      timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    const branchUser2 = branchManager.appendMessage({
      role: "user",
      content: "second smoke prompt",
      timestamp: Date.now(),
    });
    const branchFile = branchManager.getSessionFile();
    const branchSessionId = branchManager.getSessionId();
    assert.ok(branchFile);

    client.send({
      kind: "req",
      id: 29,
      method: "sessions.getBranches",
      params: { sessionId: branchSessionId, filePath: branchFile },
    });
    const branches = await client.waitFor((frame) => frame.kind === "res" && frame.id === 29);
    assert.equal(branches.ok, true, JSON.stringify(branches.error));
    assert.equal(branches.result.live, false);
    assert.equal(branches.result.leafId, branchUser2);
    assert.ok(branches.result.nodes.some((node) => node.id === branchUser1));
    assert.ok(branches.result.nodes.some((node) => node.id === branchAssistant));

    client.send({
      kind: "req",
      id: 30,
      method: "sessions.switchBranch",
      params: { sessionId: branchSessionId, filePath: branchFile, leafId: branchAssistant },
    });
    const switched = await client.waitFor((frame) => frame.kind === "res" && frame.id === 30);
    assert.equal(switched.ok, true, JSON.stringify(switched.error));
    assert.equal(switched.result.leafId, branchAssistant);
    assert.equal(switched.result.live, false);

    client.send({
      kind: "req",
      id: 31,
      method: "sessions.switchBranch",
      params: { sessionId: branchSessionId, filePath: branchFile, leafId: "missing-entry" },
    });
    const switchInvalid = await client.waitFor((frame) => frame.kind === "res" && frame.id === 31);
    assert.equal(switchInvalid.ok, false);
    assert.equal(switchInvalid.error.code, "E_INVALID_PARAMS");

    // ---- cascade cleanup on host shutdown ----
    client.send({
      kind: "req",
      id: 9,
      method: "processes.start",
      params: {
        cwd: repoRoot,
        command: "node -e \"console.log('smoke-cascade'); setInterval(() => {}, 1000)\"",
        name: "smoke-cascade",
      },
    });
    const cascadeStarted = await client.waitFor((frame) => frame.kind === "res" && frame.id === 9);
    assert.equal(cascadeStarted.ok, true);
    const cascadePid = cascadeStarted.result.process.pid;
    assert.ok(cascadePid);

    const exitPromise = new Promise((resolveExit) => child.once("exit", resolveExit));
    client.send({ kind: "req", id: 10, method: "host.shutdown", params: { drainMs: 0 } });
    const shutdown = await client.waitFor((frame) => frame.kind === "res" && frame.id === 10);
    assert.equal(shutdown.ok, true);
    assert.ok(shutdown.result.stoppedProcesses >= 1);
    client.socket.destroy();

    const exitCode = await Promise.race([
      exitPromise,
      sleep(TIMEOUT_MS).then(() => {
        throw new Error("host did not exit after shutdown");
      }),
    ]);
    assert.equal(exitCode, 0);
    assert.ok(await waitForPidExit(cascadePid), "managed process must not survive host shutdown");

    console.log("agent-host smoke: OK");
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(sandbox, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("agent-host smoke: FAILED");
  console.error(error);
  process.exitCode = 1;
});
