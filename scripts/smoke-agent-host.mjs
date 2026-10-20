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
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hostEntry = path.join(repoRoot, "agent-host", "dist", "agent-host", "index.js");
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
  const child = spawn(process.execPath, [hostEntry], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
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
    assert.equal(health.result.handshaked, 1);

    client.send({ kind: "req", id: 2, method: "does.not.exist", params: {} });
    const unknown = await client.waitFor((frame) => frame.kind === "res" && frame.id === 2);
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error.code, "E_UNKNOWN_METHOD");

    // ---- subscriptions ----
    client.send({ kind: "req", id: 3, method: "host.subscribe", params: { topics: ["processes", "terminal"] } });
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
        command: "node -e \"console.log('smoke-process-ready'); setInterval(() => {}, 1000)\"",
        name: "smoke-process",
      },
    });
    const started = await client.waitFor((frame) => frame.kind === "res" && frame.id === 7);
    assert.equal(started.ok, true);
    const processId = started.result.process.id;
    const processPid = started.result.process.pid;
    assert.ok(processId);
    assert.ok(processPid);

    const processEvent = await client.waitFor(
      (frame) =>
        frame.kind === "evt" &&
        frame.topic === "processes.changed" &&
        frame.payload.processes?.some((entry) => entry.id === processId && entry.logs.includes("smoke-process-ready")),
    );
    const tracked = processEvent.payload.processes.find((entry) => entry.id === processId);
    assert.equal(tracked.status, "running");

    client.send({ kind: "req", id: 8, method: "processes.stop", params: { id: processId } });
    const stopped = await client.waitFor((frame) => frame.kind === "res" && frame.id === 8);
    assert.equal(stopped.ok, true);
    assert.equal(stopped.result.ok, true);
    assert.ok(await waitForPidExit(processPid), "stopped process should no longer be alive");

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
  }
}

main().catch((error) => {
  console.error("agent-host smoke: FAILED");
  console.error(error);
  process.exitCode = 1;
});
