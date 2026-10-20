#!/usr/bin/env node
/**
 * Extension UI Bridge smoke.
 *
 * Spawns an Agent Host with a throwaway extension that opens a `confirm`
 * dialog on session_start, then verifies the full round-trip:
 *   Host emits extension_ui_request -> client (renderer stand-in) replies
 *   extension_ui_response -> the extension resumes -> marker file written.
 *
 * A failure here means the Host hung waiting for a dialog that the renderer
 * could not see or could not answer.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  console.error(`extension-ui smoke: missing ${hostEntry} (run npm run build:agent-host)`);
  process.exit(1);
}

function createEndpoint() {
  if (process.platform === "win32") {
    return String.raw`\\.\\pipe\\piforge-ui-smoke-${randomBytes(8).toString("hex")}`;
  }
  const dir = path.join(tmpdir(), `piforge-ui-smoke-${process.pid}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, "agent-host.sock");
}

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("host did not report ready")), TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      if (output.includes("[agent-host] ready")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`host exited before ready (code ${code})\n${output}`));
    });
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
        waitFor(predicate) {
          return (async () => {
            for (;;) {
              const frame = await next();
              if (predicate(frame)) return frame;
            }
          })();
        },
      });
    });
    socket.once("error", reject);
  });
}

async function waitForFile(file, expected, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file) && readFileSync(file, "utf8") === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`marker ${file} did not become "${expected}"`);
}

async function main() {
  const endpoint = createEndpoint();
  const token = randomBytes(32).toString("hex");
  const sandbox = mkdtempSync(path.join(tmpdir(), "piforge-ui-smoke-"));
  const agentDir = path.join(sandbox, "agent");
  const marker = path.join(sandbox, "ui-confirmed.txt");
  mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
  writeFileSync(
    path.join(agentDir, "extensions", "smoke-ui.js"),
    `import { writeFileSync } from "node:fs";
export default function (pi) {
  pi.on("session_start", (_event, ctx) => {
    void ctx.ui.confirm("PiForge smoke", "Confirm UI bridge round-trip?").then((confirmed) => {
      writeFileSync(process.env.PIFORGE_SMOKE_UI_MARKER, confirmed ? "confirmed" : "denied");
    });
  });
}
`,
  );

  const child = spawn(process.execPath, [hostEntry], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PIFORGE_AGENT_ENDPOINT: endpoint,
      PIFORGE_AGENT_TOKEN: token,
      PIFORGE_SMOKE_UI_MARKER: marker,
    },
  });
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });

  try {
    await waitForReady(child);
    const client = await createClient(endpoint);
    let nextId = 0;
    const call = async (method, params = {}) => {
      const id = ++nextId;
      client.send({ kind: "req", id, method, params });
      const frame = await client.waitFor((value) => value.kind === "res" && value.id === id);
      if (!frame.ok) throw new Error(`${method} failed: ${frame.error?.message ?? JSON.stringify(frame.error)}`);
      return frame.result;
    };

    client.send({
      kind: "hello",
      protocolVersion: 1,
      token,
      client: { pid: process.pid, role: "cli" },
    });
    const hello = await client.waitFor((frame) => frame.kind === "hello_ok" || frame.kind === "hello_error");
    assert.equal(hello.kind, "hello_ok", "expected hello_ok");

    const created = await call("agent.create", {
      cwd: sandbox,
      command: { type: "get_state" },
    });
    assert.ok(created.sessionId, "agent.create must return a session id");

    await call("agent.subscribe", { sessionId: created.sessionId });
    const request = await client.waitFor(
      (frame) =>
        frame.kind === "evt" &&
        frame.payload?.event?.type === "extension_ui_request",
    );
    assert.equal(request.payload.event.method, "confirm");
    assert.equal(request.payload.event.title, "PiForge smoke");
    assert.ok(request.payload.event.id);

    await call("agent.command", {
      sessionId: created.sessionId,
      command: {
        type: "extension_ui_response",
        id: request.payload.event.id,
        confirmed: true,
      },
    });
    await waitForFile(marker, "confirmed");

    await call("agent.destroy", { sessionId: created.sessionId });
    client.send({ kind: "req", id: ++nextId, method: "host.shutdown", params: { drainMs: 0 } });
    await client.waitFor((frame) => frame.kind === "res" && frame.id === nextId);
    client.socket.destroy();

    console.log("extension-ui smoke: OK (confirm round-trip, host did not hang)");
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(sandbox, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("extension-ui smoke: FAILED");
  console.error(error);
  process.exitCode = 1;
});
