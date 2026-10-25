#!/usr/bin/env node
/**
 * 每轮增量去重 A/B 实测（记录型 provider，不花钱、可重复）。
 *
 * 用假模型按固定脚本发起工具调用（read 同一文件两次、同一 bash 两次、一次失败命令、
 * 一次不同区间的 read），然后把**最后一次请求体**里累积的工具结果拿出来比对：
 *   - dedupe ON  vs  OFF 的请求体 token 数（省了多少）；
 *   - 去重命中次数与替代文案；
 *   - 失败命令的结果是否**完整保留**（去重不能碰错误）。
 *
 * 用法：
 *   node scripts/measure-increment.mjs            # A/B 一次跑完
 *   node scripts/measure-increment.mjs --json     # 机器可读
 *
 * 退出码：0 正常；1 环境问题；2 断言失败（错误被去重 / 命中数为 0）。
 */
import { spawnNodeHost } from "./lib/host-spawn.mjs";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { estimateTokens, startRecorder } from "./lib/prefix-measure.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const asJson = args.includes("--json");
const hostEntry = path.join(repoRoot, "agent-host", "dist", "agent-host", "index.js");

const STEPS = [
  // 同一文件同一区间重复读 → 第二次只回一句
  { tool: "read", args: { path: "package.json" } },
  { tool: "read", args: { path: "package.json" } },
  // 同一命令重复跑 → 输出一致，只回一句
  { tool: "bash", args: { command: "cat tmp/increment-probe.log" } },
  { tool: "bash", args: { command: "cat tmp/increment-probe.log" } },
  // 文件在中间被追加了一行，再跑同一条命令 → 只回尾部差异
  { tool: "bash", args: { command: "printf 'tail-marker\n ' >> tmp/increment-probe.log" } },
  { tool: "bash", args: { command: "cat tmp/increment-probe.log" } },
  // 失败命令 → 永远完整返回（不参与去重）
  { tool: "bash", args: { command: "ls /definitely-not-here-piforge" } },
  // 不同区间读同一文件 → 不去重
  { tool: "read", args: { path: "package.json", offset: 5, limit: 5 } },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createEndpoint() {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\piforge-increment-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  }
  const dir = mkdtempSync(path.join(tmpdir(), "piforge-increment-"));
  return path.join(dir, "agent-host.sock");
}

function waitForReady(child, logs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("host did not report ready")), 60_000);
    const finish = (error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    child.stdout.on("data", (chunk) => {
      logs.push(chunk.toString("utf8"));
      if (logs.join("").includes("[agent-host] ready")) finish(null);
    });
    child.stderr.on("data", (chunk) => logs.push(chunk.toString("utf8")));
    child.once("exit", (code) => finish(new Error(`host exited (code ${code})`)));
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
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) {
          try {
            deliver(JSON.parse(line));
          } catch {
            /* ignore */
          }
        }
        index = buffer.indexOf("\n");
      }
    });
    const next = () => {
      if (pending.length > 0) return Promise.resolve(pending.shift());
      return new Promise((done) => waiters.push(done));
    };
    socket.once("error", reject);
    socket.once("connect", () =>
      resolve({
        send: (frame) => socket.write(`${JSON.stringify(frame)}\n`),
        waitFor: async (predicate) => {
          for (;;) {
            const frame = await next();
            if (predicate(frame)) return frame;
          }
        },
      })
    );
  });
}

function toolTexts(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messages
    .filter((message) => message?.role === "tool")
    .map((message) =>
      typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "")
    );
}

/** 与 measure-prefix 相同的假 provider 配置（模型条目 + 信任 + 关闭保活）。 */
function writeAgentDir(agentDir, baseUrl) {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    path.join(agentDir, "models.json"),
    `${JSON.stringify(
      {
        providers: {
          measure: {
            baseUrl,
            api: "openai-completions",
            apiKey: "measure-key",
            models: [{ id: "measure-1", name: "Measure 1", contextWindow: 200_000 }],
          },
        },
      },
      null,
      2
    )}
`
  );
  writeFileSync(
    path.join(agentDir, "settings.json"),
    `${JSON.stringify(
      { defaultProvider: "measure", defaultModel: "measure-1", defaultProjectTrust: "always", cacheWarming: "off" },
      null,
      2
    )}
`
  );
  writeFileSync(path.join(agentDir, "auth.json"), `${JSON.stringify({}, null, 2)}
`);
}

/** 种一个 200 行的探针文件：重复命令 + 尾部差异都要 > MIN_DEDUPE_CHARS。 */
function seedProbeFile() {
  const target = path.join(repoRoot, "tmp", "increment-probe.log");
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, Array.from({ length: 200 }, (_, index) => `probe line ${index + 1}`).join("\n") + "\n");
  return target;
}

async function runOnce(dedupeEnabled) {
  seedProbeFile();
  const recorder = await startRecorder({ probe: { steps: STEPS }, cacheTtlMs: 300_000 });
  const agentDir = mkdtempSync(path.join(tmpdir(), "piforge-increment-agent-"));
  writeAgentDir(agentDir, recorder.baseUrl);
  const endpoint = createEndpoint();
  const token = `inc-${Math.random().toString(36).slice(2)}`;
  const logs = [];
  const child = spawnNodeHost({
    entry: hostEntry,
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PI_CODING_AGENT_DIR: agentDir,
      PIFORGE_AGENT_ENDPOINT: endpoint,
      PIFORGE_AGENT_TOKEN: token,
      PIFORGE_DEDUPE_TOOL_RESULTS: dedupeEnabled ? "1" : "0",
      PIFORGE_DEDUPE_DEBUG: "0",
    },
  });

  try {
    await waitForReady(child, logs);
    const client = await createClient(endpoint);
    client.send({ kind: "hello", protocolVersion: 1, token, client: { pid: process.pid, role: "cli" } });
    const hello = await client.waitFor((frame) => frame.kind === "hello_ok" || frame.kind === "hello_error");
    if (hello.kind !== "hello_ok") throw new Error(`handshake failed: ${JSON.stringify(hello)}`);

    client.send({
      kind: "req",
      id: 1,
      method: "agent.create",
      params: {
        cwd: repoRoot,
        agentMode: "full",
        toolPreset: "default",
        provider: "measure",
        modelId: "measure-1",
        command: { type: "prompt", message: "run the tool probe" },
      },
    });
    const created = await client.waitFor((frame) => frame.kind === "res" && frame.id === 1);
    if (!created.ok) throw new Error(`agent.create failed: ${JSON.stringify(created)}`);
    // 等最后一条请求（所有工具结果都已回填）
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const toolRequests = recorder.requests.filter((entry) => toolTexts(entry.body).length > 0);
      if (toolRequests.length > 0) {
        const latest = toolRequests.at(-1);
        if (toolTexts(latest.body).length >= STEPS.length) break;
      }
      await sleep(200);
    }
  } finally {
    try {
      child.kill();
    } catch {
      /* gone */
    }
    try {
      rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    } catch {
      /* keep temp */
    }
  }

  const toolRequests = recorder.requests.filter((entry) => toolTexts(entry.body).length > 0);
  const finalRequest = toolRequests.at(-1);
  const texts = finalRequest ? toolTexts(finalRequest.body) : [];
  await recorder.close();
  return {
    requestTokens: finalRequest ? estimateTokens(JSON.stringify(finalRequest.body)) : 0,
    toolTexts: texts,
    totalToolChars: texts.reduce((sum, text) => sum + text.length, 0),
  };
}

if (!existsSync(hostEntry)) {
  console.error(`missing ${hostEntry} (run npm run build:agent-host)`);
  process.exit(1);
}

const off = await runOnce(false);
const on = await runOnce(true);

const DEDUPE_MARKER = /Unchanged since toolCall|Same as toolCall/;
const dedupeHits = on.toolTexts.filter((text) => DEDUPE_MARKER.test(text));
const errorText = on.toolTexts.find((text) => /definitely-not-here-piforge|No such file/i.test(text));
const errorIntact = Boolean(errorText && errorText.length > 20 && !DEDUPE_MARKER.test(errorText));

const report = {
  measuredAt: new Date().toISOString(),
  steps: STEPS.length,
  dedupeOff: { requestTokens: off.requestTokens, toolChars: off.totalToolChars },
  dedupeOn: { requestTokens: on.requestTokens, toolChars: on.totalToolChars },
  savedTokens: off.requestTokens - on.requestTokens,
  savedPct:
    off.requestTokens > 0
      ? Number((((off.requestTokens - on.requestTokens) / off.requestTokens) * 100).toFixed(1))
      : 0,
  dedupeHits: dedupeHits.length,
  errorPassthroughIntact: errorIntact,
  sampleReplacement: dedupeHits[0]?.slice(0, 160) ?? null,
};

if (asJson) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  console.log("== 每轮增量去重 A/B ==");
  console.log(`请求体 ≈tok: OFF ${report.dedupeOff.requestTokens} → ON ${report.dedupeOn.requestTokens}（省 ${report.savedTokens} tok / ${report.savedPct}%）`);
  console.log(`工具结果总字符: OFF ${report.dedupeOff.toolChars} → ON ${report.dedupeOn.toolChars}`);
  console.log(`去重命中: ${report.dedupeHits} 次`);
  console.log(`失败命令结果完整保留: ${report.errorPassthroughIntact ? "✓" : "✗"}`);
  if (report.sampleReplacement) console.log(`样例: ${report.sampleReplacement}`);
}

if (report.dedupeHits === 0 || !report.errorPassthroughIntact) process.exit(2);
