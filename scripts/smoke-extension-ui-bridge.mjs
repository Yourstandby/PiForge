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
/**
 * 每帧等待的预算。CI（尤其 macOS runner）冷启动 + APFS 首次读几万个
 * node_modules 文件，20s 曾经把一次**正常**的启动判成死锁：报错信息里没有
 * 任何阶段信息，只能看到一句 timed out。默认放宽到 60s，可用
 * `PIFORGE_SMOKE_UI_TIMEOUT_MS`（或通用的 `PIFORGE_SMOKE_TIMEOUT_MS`）覆盖。
 */
const TIMEOUT_MS =
  Number(process.env.PIFORGE_SMOKE_UI_TIMEOUT_MS ?? process.env.PIFORGE_SMOKE_TIMEOUT_MS ?? "") || 60_000;
const startedAt = Date.now();

function phase(name, detail) {
  const elapsed = Date.now() - startedAt;
  console.log(`extension-ui smoke: [${elapsed}ms] ${name}${detail ? ` — ${detail}` : ""}`);
}

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
    const timer = setTimeout(
      () => reject(new Error(`host did not report ready within ${TIMEOUT_MS}ms\n${output.slice(-4000)}`)),
      TIMEOUT_MS,
    );
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

function describeFrame(frame) {
  if (!frame || typeof frame !== "object") return String(frame);
  if (frame.kind === "evt") return `evt:${frame.payload?.event?.type ?? "?"}`;
  if (frame.kind === "res") return `res#${frame.id}${frame.ok === false ? "(error)" : ""}`;
  return String(frame.kind);
}

function createClient(endpoint) {
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint);
    let buffer = "";
    /**
     * 已到达但还没被匹配的帧。旧实现是「取一帧就去对谓词，不对就丢掉」，
     * 于是「等 A 的回复」期间顺带到达的 B 事件被永久吞掉，之后等 B 就永远
     * 等不到（表现恰好也是 timed out waiting for a frame）。现在只取出匹配的帧。
     */
    const queue = [];
    /** 最近收到的帧类型，超时时报出来，一眼能看出卡在哪一步。 */
    const seen = [];
    let wake = null;

    const push = (frame) => {
      if (frame.kind === "ping") {
        socket.write(`${JSON.stringify({ kind: "pong", nonce: frame.nonce })}\n`);
        return;
      }
      queue.push(frame);
      seen.push(describeFrame(frame));
      if (seen.length > 20) seen.shift();
      const waiter = wake;
      wake = null;
      waiter?.();
    };

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        try {
          push(JSON.parse(line));
        } catch (error) {
          console.error(`extension-ui smoke: unparsable frame (${error.message}): ${line.slice(0, 200)}`);
        }
      }
    });
    socket.once("connect", () => {
      const take = (predicate) => {
        const index = queue.findIndex(predicate);
        return index === -1 ? null : queue.splice(index, 1)[0];
      };
      const timeoutError = (label, timeoutMs) =>
        new Error(
          `timed out waiting for ${label} after ${timeoutMs}ms` +
            (seen.length > 0 ? `; recent frames: ${seen.join(", ")}` : "; no frames received"),
        );
      resolve({
        socket,
        send(frame) {
          socket.write(`${JSON.stringify(frame)}\n`);
        },
        /**
         * 等第一个满足 predicate 的帧。`label` 会进超时信息，出错时能直接看出
         * 是 hello / agent.create / agent.subscribe / extension_ui_request 哪一步。
         */
        async waitFor(predicate, label = "frame", timeoutMs = TIMEOUT_MS) {
          const deadline = Date.now() + timeoutMs;
          for (;;) {
            const hit = take(predicate);
            if (hit) return hit;
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw timeoutError(label, timeoutMs);
            await new Promise((resolveNext, rejectNext) => {
              const timer = setTimeout(() => {
                wake = null;
                rejectNext(timeoutError(label, timeoutMs));
              }, remaining);
              wake = () => {
                clearTimeout(timer);
                resolveNext();
              };
            });
          }
        },
      });
    });
    socket.once("error", reject);
  });
}

async function waitForFile(file, expected, timeoutMs = Math.min(TIMEOUT_MS, 30_000)) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file) && readFileSync(file, "utf8") === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`marker ${file} did not become "${expected}"`);
}

async function runRoundTrip(attempt) {
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
      // stdio[0] 是 "ignore"：父进程若带 PIFORGE_HOST_STDIN_CONTROL=1（在 PiForge
      // 自己的终端里跑回归就会继承），host 会把 stdin EOF 当成"父进程死了"直接退出。
      PIFORGE_HOST_STDIN_CONTROL: "0",
      PIFORGE_AGENT_ENDPOINT: endpoint,
      PIFORGE_AGENT_TOKEN: token,
      PIFORGE_SMOKE_UI_MARKER: marker,
    },
  });
  // Host 日志实时回显（CI 里能看进度），同时留一份尾巴：失败时把最后几十行
  // 追在错误里，否则 CI 日志一交错就什么都看不出来。
  const hostTail = [];
  const tee = (chunk, target) => {
    target.write(chunk);
    for (const line of chunk.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      hostTail.push(line);
      if (hostTail.length > 40) hostTail.shift();
    }
  };
  child.stdout.on("data", (chunk) => tee(chunk, process.stdout));
  child.stderr.on("data", (chunk) => tee(chunk, process.stderr));

  try {
    phase(`attempt ${attempt}: spawning host`, endpoint);
    await waitForReady(child);
    phase("host ready");
    const client = await createClient(endpoint);
    let nextId = 0;
    const call = async (method, params = {}) => {
      const id = ++nextId;
      client.send({ kind: "req", id, method, params });
      const frame = await client.waitFor(
        (value) => value.kind === "res" && value.id === id,
        `${method} response`,
      );
      if (!frame.ok) throw new Error(`${method} failed: ${frame.error?.message ?? JSON.stringify(frame.error)}`);
      return frame.result;
    };

    client.send({
      kind: "hello",
      protocolVersion: 1,
      token,
      client: { pid: process.pid, role: "cli" },
    });
    const hello = await client.waitFor(
      (frame) => frame.kind === "hello_ok" || frame.kind === "hello_error",
      "handshake (hello_ok)",
    );
    assert.equal(hello.kind, "hello_ok", "expected hello_ok");
    phase("handshake ok");

    const created = await call("agent.create", {
      cwd: sandbox,
      command: { type: "get_state" },
    });
    assert.ok(created.sessionId, "agent.create must return a session id");
    phase("agent.create ok", `sessionId=${created.sessionId}`);

    await call("agent.subscribe", { sessionId: created.sessionId });
    phase("agent.subscribe ok");
    const request = await client.waitFor(
      (frame) =>
        frame.kind === "evt" &&
        frame.payload?.event?.type === "extension_ui_request",
      "extension_ui_request (confirm)",
    );
    phase("extension_ui_request received", `method=${request.payload.event.method}`);
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
    phase("marker confirmed");

    await call("agent.destroy", { sessionId: created.sessionId });
    client.send({ kind: "req", id: ++nextId, method: "host.shutdown", params: { drainMs: 0 } });
    await client.waitFor((frame) => frame.kind === "res" && frame.id === nextId, "host.shutdown response");
    client.socket.destroy();
  } catch (error) {
    error.hostTail = hostTail.slice(-15);
    throw error;
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(sandbox, { recursive: true, force: true });
    if (process.platform !== "win32") rmSync(path.dirname(endpoint), { recursive: true, force: true });
  }
}

async function main() {
  // CI 冷启动/磁盘抖动可能让第一次尝试撞超时（macOS runner 尤其明显）；
  // 超时值本身就放宽了，再保一次重试，避免用一个瞬时抖动卡死整条发布流水线。
  const attempts = Number(process.env.PIFORGE_SMOKE_UI_ATTEMPTS ?? "") || 2;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await runRoundTrip(attempt);
      console.log(
        `extension-ui smoke: OK (confirm round-trip, host did not hang) — attempt ${attempt}/${attempts}, total ${Date.now() - startedAt}ms`,
      );
      return;
    } catch (error) {
      lastError = error;
      console.error(`extension-ui smoke: attempt ${attempt}/${attempts} failed: ${error.message}`);
      if (error.hostTail?.length) {
        console.error(`extension-ui smoke: host output tail:\n    ${error.hostTail.join("\n    ")}`);
      }
      if (attempt < attempts) console.error("extension-ui smoke: retrying once (CI cold-start jitter)");
    }
  }
  throw lastError;
}

main().catch((error) => {
  console.error("extension-ui smoke: FAILED");
  console.error(error);
  process.exitCode = 1;
});
