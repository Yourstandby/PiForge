#!/usr/bin/env node
/**
 * Packaged lifecycle smoke: packaged Host -> Next SSE proxy.
 *
 * A throwaway Host extension spawns one real subagent with a faux model. The
 * smoke opens the packaged Next SSE route first, then asserts started/output/
 * finished frames arrive through the proxy. This exercises the asar/standalone
 * module graph rather than the dev source path.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const packagedDir = process.env.PIFORGE_PACKAGED_DIR
  ? path.resolve(process.env.PIFORGE_PACKAGED_DIR)
  : path.join(repoRoot, "release", "win-unpacked");
const resources = path.join(packagedDir, "resources");
const standalone = path.join(resources, "standalone");
const hostEntry = process.env.PIFORGE_HOST_ENTRY
  ? path.resolve(process.env.PIFORGE_HOST_ENTRY)
  : path.join(standalone, "agent-host", "index.js");
const serverEntry = path.join(standalone, "server.js");
const hostModules = path.join(standalone, "agent-host", "agent-host");
const piAiEntry = path.join(standalone, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js");

for (const [label, file] of [["host", hostEntry], ["next server", serverEntry], ["pi-ai", piAiEntry], ["subagents", path.join(hostModules, "subagents.js")]]) {
  if (!existsSync(file)) {
    console.error(`packaged-events smoke: missing ${label}: ${file}`);
    process.exit(1);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function endpointName() {
  if (process.platform === "win32") {
    const bs = String.fromCharCode(92);
    return `${bs}${bs}.${bs}pipe${bs}piforge-events-${randomBytes(6).toString("hex")}`;
  }
  return path.join(tmpdir(), `piforge-events-${process.pid}.sock`);
}

function waitForReady(child, marker, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${marker}\n${output}`)), timeoutMs);
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes(marker)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code) => reject(new Error(`exited before ${marker} (${code})\n${output}`)));
  });
}

function connectHost(endpoint) {
  return new Promise((resolve, reject) => {
    // Reuse the same tiny newline-framed protocol as the other smoke scripts.
    import("node:net").then(({ connect }) => {
      const socket = connect(endpoint);
      let buffer = "";
      const pending = [];
      const waiters = [];
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        let index;
        while ((index = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!line) continue;
          const frame = JSON.parse(line);
          if (frame.kind === "ping") {
            socket.write(`${JSON.stringify({ kind: "pong", nonce: frame.nonce })}\n`);
            continue;
          }
          const waiter = waiters.shift();
          if (waiter) waiter(frame);
          else pending.push(frame);
        }
      });
      socket.once("error", reject);
      const next = () => pending.length > 0
        ? Promise.resolve(pending.shift())
        : new Promise((ok) => waiters.push(ok));
      socket.once("connect", () => resolve({
        socket,
        send(frame) { socket.write(`${JSON.stringify(frame)}\n`); },
        waitFor(predicate) {
          return (async () => {
            for (;;) {
              const frame = await next();
              if (predicate(frame)) return frame;
            }
          })();
        },
      }));
    }, reject);
  });
}

async function main() {
  const sandbox = mkdtempSync(path.join(tmpdir(), "piforge-packaged-events-"));
  const agentDir = path.join(sandbox, "agent");
  const marker = path.join(sandbox, "extension-spawned.txt");
  mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
  const cwd = sandbox;
  const fileUrl = (value) => pathToFileURL(value).href;
  writeFileSync(
    path.join(agentDir, "extensions", "packaged-events.js"),
    `import { writeFileSync } from "node:fs";
import { spawnSubagent } from ${JSON.stringify(fileUrl(path.join(hostModules, "subagents.js")))};
import { getSharedAuxRuntime } from ${JSON.stringify(fileUrl(path.join(hostModules, "aux-models.js")))};
import { fauxProvider, fauxAssistantMessage } from ${JSON.stringify(fileUrl(piAiEntry))};

export default function (pi) {
  pi.on("session_start", async () => {
    try {
      const runtime = await getSharedAuxRuntime();
      const faux = fauxProvider({ provider: "packaged-events", api: "packaged-events-api" });
      runtime.registerNativeProvider(faux.provider);
      faux.setResponses([fauxAssistantMessage("packaged subagent report")]);
      await spawnSubagent({
        name: "packaged-scout",
        task: "Emit a packaged lifecycle report.",
        cwd: ${JSON.stringify(cwd)},
        parentSessionId: "packaged-parent",
        model: faux.getModel(),
      });
      writeFileSync(${JSON.stringify(marker)}, "done");
    } catch (error) {
      writeFileSync(${JSON.stringify(marker)}, "error:" + (error && error.message ? error.message : String(error)));
    }
  });
}
`,
  );

  const endpoint = endpointName();
  const token = randomBytes(32).toString("hex");
  const port = await freePort();
  const host = spawn(process.execPath, [hostEntry], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      // stdio[0] 是 "ignore"：父进程若带 PIFORGE_HOST_STDIN_CONTROL=1（在 PiForge
      // 自己的终端里跑回归就会继承），host 会把 stdin EOF 当成"父进程死了"直接退出。
      PIFORGE_HOST_STDIN_CONTROL: "0",
      PIFORGE_AGENT_ENDPOINT: endpoint,
      PIFORGE_AGENT_TOKEN: token,
    },
  });
  let server;
  try {
    await waitForReady(host, "[agent-host] ready");
    const client = await connectHost(endpoint);
    client.send({ kind: "hello", protocolVersion: 1, token, client: { pid: process.pid, role: "cli" } });
    assert.equal((await client.waitFor((frame) => frame.kind === "hello_ok" || frame.kind === "hello_error")).kind, "hello_ok");

    server = spawn(process.execPath, [serverEntry], {
      cwd: standalone,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NODE_ENV: "production",
        HOSTNAME: "127.0.0.1",
        PORT: String(port),
        PI_CODING_AGENT_DIR: agentDir,
        PIFORGE_AGENT_ENDPOINT: endpoint,
        PIFORGE_AGENT_TOKEN: token,
      },
    });
    const health = `http://127.0.0.1:${port}/api/health`;
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        if ((await fetch(health)).status === 200) break;
      } catch {
        // still starting
      }
      if (Date.now() > deadline) throw new Error("packaged Next server did not become healthy");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    const events = [];
    const response = await fetch(`http://127.0.0.1:${port}/api/subagents/events`);
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const frames = [];
    const readLoop = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          for (const line of block.split(String.fromCharCode(10))) {
            if (!line.startsWith("data: ")) continue;
            const payload = JSON.parse(line.slice(6));
            frames.push(payload);
            if (payload.event) events.push(payload.event.type);
            for (const item of payload.events ?? []) events.push(item.type);
          }
        }
      }
    })();

    // Wait for the initial SSE snapshot so the Host subscription is live
    // before the extension emits started/output.
    for (let attempt = 0; attempt < 200 && !frames.some((frame) => frame.type === "subagents"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!frames.some((frame) => frame.type === "subagents")) throw new Error("SSE initial snapshot did not arrive");
    // The route sends its initial snapshot before awaiting Host subscribe;
    // give the subscription a beat to attach before emitting lifecycle events.
    await new Promise((resolve) => setTimeout(resolve, 500));

    client.send({ kind: "req", id: 1, method: "agent.create", params: { cwd: sandbox, command: { type: "get_state" } } });
    const created = await client.waitFor((frame) => frame.kind === "res" && frame.id === 1);
    assert.equal(created.ok, true, JSON.stringify(created.error));

    const waitForEvents = async (needed) => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if (needed.every((type) => events.includes(type))) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`missing SSE lifecycle events: ${needed.join(", ")}; got ${events.join(", ")}`);
    };
    await waitForEvents(["subagent_started", "subagent_output", "subagent_finished"]);
    const markerText = readFileSync(marker, "utf8");
    assert.equal(markerText, "done", markerText);
    const snapshot = await (await fetch(`http://127.0.0.1:${port}/api/subagents`)).json();
    assert.ok(snapshot.agents.some((agent) => agent.name === "packaged-scout"));

    reader.cancel().catch(() => undefined);
    await readLoop.catch(() => undefined);
    console.log(`packaged-events smoke: OK (${events.join(" -> ")})`);
  } finally {
    server?.kill();
    host.kill();
    rmSync(sandbox, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("packaged-events smoke: FAILED");
  console.error(error);
  process.exitCode = 1;
});
