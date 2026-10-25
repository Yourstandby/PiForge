#!/usr/bin/env node
/**
 * Dev orchestrator: Agent Host + Next.js dev server.
 *
 * The Agent Host is a plain Node process (no Electron APIs), so the browser
 * development flow can use the exact same isolation as the desktop app.
 * The endpoint is stable for the lifetime of this script; the token is shared
 * with Next through the environment and never written to disk.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hostEntry = path.join(repoRoot, "agent-host", "dist", "agent-host", "index.js");
const nextBin = path.join(repoRoot, "node_modules", "next", "dist", "bin", "next");
const port = process.env.PORT?.trim() || "30141";
const HOST_READY_TIMEOUT_MS = 10_000;

function createEndpoint() {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\piforge-agent-${randomBytes(16).toString("hex")}`;
  }
  const dir = path.join(tmpdir(), `piforge-${process.getuid?.() ?? "user"}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, "agent-host.sock");
}

const endpoint = process.env.PIFORGE_AGENT_ENDPOINT?.trim() || createEndpoint();
const token = process.env.PIFORGE_AGENT_TOKEN?.trim() || randomBytes(32).toString("hex");

let host = null;
let next = null;
let shuttingDown = false;

function stopChildren(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of [next, host]) {
    if (child && child.exitCode === null) {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
    }
  }
  setTimeout(() => process.exit(code), 300);
}

process.on("SIGINT", () => stopChildren(130));
process.on("SIGTERM", () => stopChildren(143));
process.on("exit", () => {
  for (const child of [next, host]) {
    if (child && child.exitCode === null) {
      try {
        child.kill();
      } catch {
        // Best effort during process teardown.
      }
    }
  }
});

function startHost() {
  if (!existsSync(hostEntry)) {
    console.warn(`[dev] Agent Host build missing: ${hostEntry}`);
    console.warn("[dev] Run `npm run build:agent-host`, starting Next.js without the host.");
    return null;
  }

  console.log(`[dev] Starting Agent Host (endpoint: ${endpoint})`);
  const child = spawn(process.execPath, [hostEntry], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      // stdio[0] 是 "ignore"：别让继承来的 PIFORGE_HOST_STDIN_CONTROL=1
      // 让 host 把 stdin EOF 当成父进程死了（scripts/host-spawn-stdin.test.mjs）。
      PIFORGE_HOST_STDIN_CONTROL: "0",
      PIFORGE_AGENT_ENDPOINT: endpoint,
      PIFORGE_AGENT_TOKEN: token,
    },
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.once("exit", (code, signal) => {
    if (!shuttingDown) {
      console.warn(`[dev] Agent Host exited (code=${code}, signal=${signal ?? "none"}); Next.js keeps running without it.`);
    }
  });
  return child;
}

function waitForHostReady(child) {
  if (!child) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (ready, detail) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.stdout.off("data", onData);
      if (!ready) console.warn(`[dev] Agent Host not ready: ${detail}`);
      resolve(ready);
    };
    const onData = (chunk) => {
      if (chunk.toString("utf8").includes("[agent-host] ready")) finish(true);
    };
    child.stdout.on("data", onData);
    child.once("exit", (code) => finish(false, `exited with code ${code}`));
    timer = setTimeout(() => finish(false, `timeout after ${HOST_READY_TIMEOUT_MS}ms`), HOST_READY_TIMEOUT_MS);
  });
}

function startNext(hostReady) {
  const env = {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV ?? "development",
    PORT: port,
    NEXT_TELEMETRY_DISABLED: "1",
  };
  if (hostReady) {
    env.PIFORGE_AGENT_ENDPOINT = endpoint;
    env.PIFORGE_AGENT_TOKEN = token;
  }

  console.log(`[dev] Starting Next.js on port ${port}`);
  const child = spawn(process.execPath, [nextBin, "dev", "-p", port], {
    cwd: repoRoot,
    stdio: "inherit",
    env,
  });
  child.once("exit", (code, signal) => {
    console.log(`[dev] Next.js exited (code=${code}, signal=${signal ?? "none"})`);
    stopChildren(code ?? 0);
  });
  child.once("error", (error) => {
    console.error("[dev] Failed to start Next.js", error);
    stopChildren(1);
  });
  return child;
}

host = startHost();
const hostReady = await waitForHostReady(host);
if (hostReady) console.log("[dev] Agent Host ready; starting Next.js");
next = startNext(hostReady);
