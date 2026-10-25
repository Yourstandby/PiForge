#!/usr/bin/env node
/**
 * Reconnect smoke test for the shared Agent Host client.
 *
 * Starts a host, subscribes to the process stream, kills the host, starts a
 * replacement on the same endpoint, and verifies that the client transitions
 * back to "ready" and re-registers its subscription (receives a fresh
 * snapshot) without the caller doing anything.
 */
import { spawnNodeHost } from "./lib/host-spawn.mjs";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hostEntry = path.join(repoRoot, "agent-host", "dist", "agent-host", "index.js");
const TIMEOUT_MS = 20_000;

if (!existsSync(hostEntry)) {
  console.error(`host reconnect smoke: missing ${hostEntry} (run npm run build:agent-host)`);
  process.exit(1);
}

function createEndpoint() {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\piforge-reconnect-${randomBytes(8).toString("hex")}`;
  }
  const dir = path.join(tmpdir(), `piforge-reconnect-${process.pid}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, "agent-host.sock");
}

const endpoint = createEndpoint();
const token = randomBytes(32).toString("hex");
process.env.PIFORGE_AGENT_ENDPOINT = endpoint;
process.env.PIFORGE_AGENT_TOKEN = token;

function startHost() {
  const child = spawnNodeHost({
    entry: hostEntry,
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PIFORGE_AGENT_ENDPOINT: endpoint,
      PIFORGE_AGENT_TOKEN: token,
    },
  });
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    if (text.includes("[agent-host]")) process.stdout.write(text);
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  return child;
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

function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

async function waitFor(predicate, label, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  const { getAgentHostClient } = await import(pathToFileURL(path.join(repoRoot, "lib", "agent-host-client.ts")).href);
  const client = getAgentHostClient();

  let child = startHost();
  await waitForHostReady(child);

  const snapshots = [];
  const subscription = await client.subscribe("processes", (payload) => {
    snapshots.push(payload);
  });
  await waitFor(() => snapshots.length >= 1, "initial process snapshot");

  await client.call("processes.start", {
    cwd: repoRoot,
    command: "node -e \"setInterval(() => {}, 1000)\"",
    name: "reconnect-smoke",
  });
  await waitFor(
    () => snapshots.some((payload) => payload.processes?.some((item) => item.name === "reconnect-smoke")),
    "started process snapshot",
  );

  const beforeRestart = snapshots.length;
  child.kill("SIGTERM");
  await waitForExit(child);
  await waitFor(() => client.status === "reconnecting" || client.status === "idle", "client reconnect state");

  child = startHost();
  await waitForHostReady(child);
  await waitFor(() => client.status === "ready", "client ready after host restart", 25_000);
  await waitFor(() => snapshots.length > beforeRestart, "re-registered process subscription snapshot");

  const fresh = snapshots[snapshots.length - 1];
  assert.deepEqual(fresh.processes, [], "replacement host starts with an empty process registry");

  subscription.close();
  client.close();
  child.kill("SIGTERM");
  await waitForExit(child);
  console.log("host reconnect smoke: OK");
}

main().catch((error) => {
  console.error("host reconnect smoke: FAILED");
  console.error(error);
  process.exitCode = 1;
});
