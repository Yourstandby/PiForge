#!/usr/bin/env node
/**
 * Isolation smoke test for Step 2.
 *
 * Proves the property that matters: the Agent Host keeps streaming while the
 * client (the Next.js server in production) disappears, and a fresh client can
 * reconnect and receive the remaining stream.
 *
 * Runs fully offline with a fake OpenAI-completions server, so it does not
 * depend on credentials or an external model.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hostEntry = path.join(repoRoot, "agent-host", "dist", "agent-host", "index.js");
const TIMEOUT_MS = 30_000;
const TOKEN_COUNT = 24;
const TOKEN_DELAY_MS = 200;

if (!existsSync(hostEntry)) {
  console.error(`agent isolation smoke: missing ${hostEntry} (run npm run build:agent-host)`);
  process.exit(1);
}

function createEndpoint() {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\piforge-isolation-${randomBytes(8).toString("hex")}`;
  }
  const dir = path.join(tmpdir(), `piforge-isolation-${process.pid}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, "agent-host.sock");
}

function startFakeLlm() {
  const server = createServer((req, res) => {
    if (!req.url?.includes("/chat/completions")) {
      res.writeHead(404).end("not found");
      return;
    }
    // Drain the request body; contents are irrelevant.
    req.resume();
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    const chunk = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    const base = {
      id: "chatcmpl-fake",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "fake-stream",
    };

    chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
    let index = 0;
    const timer = setInterval(() => {
      if (index < TOKEN_COUNT) {
        chunk({
          ...base,
          choices: [{ index: 0, delta: { content: `tok${index} ` }, finish_reason: null }],
        });
        index += 1;
        return;
      }
      clearInterval(timer);
      chunk({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 8, completion_tokens: TOKEN_COUNT, total_tokens: 8 + TOKEN_COUNT },
      });
      res.write("data: [DONE]\n\n");
      res.end();
    }, TOKEN_DELAY_MS);

    res.on("close", () => {
      clearInterval(timer);
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to allocate fake LLM port"));
        return;
      }
      resolve({
        port: address.port,
        close: () => new Promise((done) => server.close(() => done(null))),
      });
    });
  });
}

function waitForHostReady(child) {
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
    child.once("exit", (code) => finish(new Error(`host exited before ready (code ${code})\n${output}`)));
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

async function handshake(endpoint, token) {
  const client = await createClient(endpoint);
  client.send({
    kind: "hello",
    protocolVersion: 1,
    token,
    client: { pid: process.pid, role: "cli" },
  });
  const hello = await client.waitFor((frame) => frame.kind === "hello_ok" || frame.kind === "hello_error");
  assert.equal(hello.kind, "hello_ok");
  return client;
}

async function main() {
  const fake = await startFakeLlm();
  const agentDir = mkdtempSync(path.join(tmpdir(), "piforge-isolation-agent-"));
  const projectDir = mkdtempSync(path.join(tmpdir(), "piforge-isolation-project-"));
  const endpoint = createEndpoint();
  const token = randomBytes(32).toString("hex");

  writeFileSync(
    path.join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        openai: {
          baseUrl: `http://127.0.0.1:${fake.port}/v1`,
          api: "openai-completions",
          models: [
            {
              id: "fake-stream",
              name: "Fake Stream",
              api: "openai-completions",
              input: ["text"],
              reasoning: false,
              contextWindow: 128000,
              maxTokens: 4096,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }, null, 2),
    "utf8",
  );

  const child = spawn(process.execPath, [hostEntry], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      OPENAI_API_KEY: "test-key",
      PIFORGE_AGENT_ENDPOINT: endpoint,
      PIFORGE_AGENT_TOKEN: token,
    },
  });
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });

  try {
    await waitForHostReady(child);

    let client = await handshake(endpoint, token);
    client.send({
      kind: "req",
      id: 1,
      method: "agent.create",
      params: {
        cwd: projectDir,
        provider: "openai",
        modelId: "fake-stream",
        command: { type: "prompt", message: "Stream a long answer." },
      },
    });
    const created = await client.waitFor((frame) => frame.kind === "res" && frame.id === 1);
    assert.equal(created.ok, true, JSON.stringify(created));
    const sessionId = created.result.sessionId;
    assert.ok(sessionId);

    client.send({ kind: "req", id: 2, method: "agent.subscribe", params: { sessionId } });
    const subscribed = await client.waitFor((frame) => frame.kind === "res" && frame.id === 2);
    assert.equal(subscribed.ok, true, JSON.stringify(subscribed));

    let firstSeq = null;
    let lastSeqBeforeDrop = 0;
    for (;;) {
      const frame = await client.next();
      if (frame.kind !== "evt" || frame.topic !== "agent.event") continue;
      firstSeq ??= frame.seq;
      lastSeqBeforeDrop = frame.seq;
      const event = frame.payload?.event;
      if (event?.type === "message_update" || event?.type === "message_start") break;
    }
    assert.ok(firstSeq >= 1);

    // Simulate the Next.js server dying mid-stream.
    client.socket.destroy();
    await sleep(700);

    // A fresh client inspects the session: the agent must still be running.
    client = await handshake(endpoint, token);
    client.send({ kind: "req", id: 3, method: "sessions.state", params: { sessionId } });
    const stateWhileDropped = await client.waitFor((frame) => frame.kind === "res" && frame.id === 3);
    assert.equal(stateWhileDropped.ok, true);
    assert.equal(stateWhileDropped.result.running, true, "agent should survive the client disconnect");

    client.send({ kind: "req", id: 4, method: "agent.subscribe", params: { sessionId } });
    const resubscribed = await client.waitFor((frame) => frame.kind === "res" && frame.id === 4);
    assert.equal(resubscribed.ok, true, JSON.stringify(resubscribed));

    const resumedSeqs = [];
    let sawEnd = false;
    const deadline = Date.now() + TIMEOUT_MS;
    while (!sawEnd && Date.now() < deadline) {
      const frame = await client.waitFor(
        (candidate) =>
          candidate.kind === "evt" && candidate.topic === "agent.event" && candidate.payload?.sessionId === sessionId,
      );
      resumedSeqs.push(frame.seq);
      if (frame.payload.event?.type === "agent_end") sawEnd = true;
    }

    assert.ok(resumedSeqs.length > 0, "expected replayed/live events after reconnect");
    assert.ok(sawEnd, "expected agent_end after reconnect");
    assert.ok(
      resumedSeqs[0] > lastSeqBeforeDrop,
      `reconnect must continue after the last delivered seq (${resumedSeqs[0]} vs ${lastSeqBeforeDrop})`,
    );
    // No gaps in the resumed sequence.
    for (let i = 1; i < resumedSeqs.length; i += 1) {
      assert.equal(resumedSeqs[i], resumedSeqs[i - 1] + 1, "agent event sequence must be contiguous");
    }

    // The same live session is still resolvable (no restart, no new id).
    client.send({ kind: "req", id: 5, method: "sessions.locate", params: { sessionId } });
    const located = await client.waitFor((frame) => frame.kind === "res" && frame.id === 5);
    assert.equal(located.ok, true);
    assert.equal(located.result.live, true);
    assert.ok(located.result.filePath);

    console.log("agent isolation smoke: OK");
    client.socket.destroy();
  } finally {
    const exited = child.exitCode !== null
      ? Promise.resolve()
      : new Promise((resolveExit) => child.once("exit", resolveExit));
    try {
      if (child.exitCode === null) child.kill("SIGTERM");
    } catch {
      // already gone
    }
    await Promise.race([exited, sleep(4_000)]);
    await fake.close();
    // Windows may keep the SQLite WAL/session files open for a few ms after
    // the host exits; retry the cleanup instead of failing the smoke.
    rmSync(agentDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error("agent isolation smoke: FAILED");
  console.error(error);
  process.exitCode = 1;
});
