#!/usr/bin/env node
/** Packaged Electron smoke: Main-owned WebContentsView + BrowserHostBridge. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createServer as createPipeServer } from "node:net";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const packagedDir = process.env.PIFORGE_PACKAGED_DIR
  ? path.resolve(process.env.PIFORGE_PACKAGED_DIR)
  : path.join(repoRoot, "release", "win-unpacked");
const executable = process.platform === "win32"
  ? path.join(packagedDir, "PiForge.exe")
  : path.join(packagedDir, process.platform === "darwin" ? "PiForge.app/Contents/MacOS/PiForge" : "PiForge");
if (!existsSync(executable)) {
  console.error(`packaged-browser smoke: missing Electron executable: ${executable}`);
  process.exit(1);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createPipeServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function pipeName() {
  if (process.platform === "win32") {
    const bs = String.fromCharCode(92);
    return `${bs}${bs}.${bs}pipe${bs}piforge-browser-smoke-${randomBytes(6).toString("hex")}`;
  }
  return path.join(tmpdir(), `piforge-browser-smoke-${process.pid}.sock`);
}

const fixture = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end("<!doctype html><html><head><title>PiForge smoke</title></head><body><h1>packaged browser fixture</h1></body></html>");
});
const port = await freePort();
await new Promise((resolve) => fixture.listen(port, "127.0.0.1", resolve));

console.log("packaged-browser smoke: starting fixture on", port);
const endpoint = pipeName();
const token = randomBytes(24).toString("hex");
const received = [];
const snapshots = [];
const pending = [];
const server = createPipeServer((socket) => {
  let buffer = "";
  let stage = 0;
  let readAt = 0;
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const frame = JSON.parse(line);
      if (frame.kind === "hello") {
        socket.write(`${JSON.stringify({ kind: "hello_ok" })}\n`);
        continue;
      }
      if (frame.kind !== "req") continue;
      if (frame.method === "browser.poll") {
        let commands = [];
        if (stage === 0) {
          stage = 1;
          commands = [{ id: "open-1", kind: "open", url: `http://127.0.0.1:${port}/`, windowId: "smoke-window", ownerId: "smoke-owner" }];
        } else if (stage === 1) {
          stage = 2;
          readAt = Date.now();
          commands = [{ id: "read-1", kind: "read" }];
        } else if (stage === 2 && Date.now() - readAt > 600) {
          stage = 3;
          commands = [{ id: "shot-1", kind: "screenshot" }];
        }
        socket.write(`${JSON.stringify({ kind: "res", id: frame.id, ok: true, result: { commands } })}
`);
        continue;
      }
      if (frame.method === "browser.resolveCommand") {
        received.push(frame.params.result);
        socket.write(`${JSON.stringify({ kind: "res", id: frame.id, ok: true, result: { ok: true } })}\n`);
        continue;
      }
      if (frame.method === "browser.pushSnapshot") {
        snapshots.push(frame.params.snapshot);
        socket.write(`${JSON.stringify({ kind: "res", id: frame.id, ok: true, result: { ok: true } })}\n`);
        continue;
      }
      socket.write(`${JSON.stringify({ kind: "res", id: frame.id, ok: true, result: {} })}\n`);
    }
  });
  pending.push(socket);
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(endpoint, resolve);
});

const child = spawn(executable, [], {
  cwd: repoRoot,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    SMOKE_BROWSER: "1",
    SMOKE_BROWSER_ENDPOINT: endpoint,
    SMOKE_BROWSER_TOKEN: token,
    SMOKE_BROWSER_FIXTURE: `http://127.0.0.1:${port}/`,
  },
});
let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk.toString();
  process.stdout.write(chunk);
});
child.stderr.on("data", (chunk) => {
  output += chunk.toString();
  process.stderr.write(chunk);
});
console.log("packaged-browser smoke: launched", executable);

try {
  const deadline = Date.now() + 40_000;
  while (received.length < 3 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(received.length >= 3, true, `missing browser command results\n${output}`);
  const open = received.find((item) => item.id === "open-1");
  const read = received.find((item) => item.id === "read-1");
  const shot = received.find((item) => item.id === "shot-1");
  assert.equal(open?.ok, true, output);
  assert.equal(read?.ok, true, JSON.stringify(read));
  assert.match(read.text ?? "", /packaged browser fixture/);
  assert.equal(shot?.ok, true, JSON.stringify(shot));
  assert.equal(shot.image?.mimeType, "image/png");
  assert.ok((shot.image?.data.length ?? 0) > 0);
  assert.equal(shot.ready, true);
  assert.ok((shot.boundsGeneration ?? 0) > 0);
  assert.ok(snapshots.some((snapshot) => snapshot.ready === true && snapshot.windowId === "smoke-window"));
  console.log(`packaged-browser smoke: OK (open/read/screenshot, ${shot.image.data.length} base64 chars)`);
} finally {
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  server.close();
  fixture.close();
  try { rmSync(endpoint, { force: true }); } catch { /* named pipe */ }
  if (received.length < 3) console.error("packaged-browser smoke: child output" + String.fromCharCode(10) + output);
}
