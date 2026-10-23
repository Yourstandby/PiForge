#!/usr/bin/env node
/**
 * 前缀度量（token 成本基线）。
 *
 * 干什么：让**真实的会话创建路径**发一次真实请求，然后把请求体拆开算账：
 *   A. `--mode host`（默认）：走 Agent Host（AgentSession + 16 个内联扩展 + 工具装载
 *      + 系统提示词拼装全部照常跑）——这是 PiForge 真实发出去的东西；
 *   B. `--mode pi`：进程内直接 `createAgentSession`，不挂任何桌面扩展、只有 pi 默认
 *      工具（read/bash/edit/write）——这是 pi CLI 发出去的东西；
 *   C. `--mode both`：两跑都做并输出对比表（默认）。
 *
 * 为什么不用真模型：真模型要钱、要网、结果不可比。这里只关心**请求体**，
 * 模型回什么都无所谓，所以本地 provider 回一段固定的假 SSE，让 turn 2 也能发生。
 *
 * 用法：
 *   npm run build:agent-host
 *   node scripts/measure-prefix.mjs                 # PiForge vs pi 对比
 *   node scripts/measure-prefix.mjs --mode host     # 只看 PiForge
 *   node scripts/measure-prefix.mjs --json > tmp/prefix.json
 *   node scripts/measure-prefix.mjs --baseline tmp/prefix.json   # 与旧快照比
 *   node scripts/measure-prefix.mjs --max-prefix 6000            # 预算护栏（超了退出码 2）
 *
 * 退出码：0 正常；1 环境/运行问题；2 超出 --max-prefix 预算。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  analyzeRequest,
  buildReport,
  compareReports,
  hasTools,
  declaredTools,
  printReport,
  readProbeResult,
  startRecorder,
} from "./lib/prefix-measure.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hostEntry = process.env.PIFORGE_HOST_ENTRY
  ? path.resolve(process.env.PIFORGE_HOST_ENTRY)
  : path.join(repoRoot, "agent-host", "dist", "agent-host", "index.js");

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const mode = valueOf("--mode") ?? "both";
const baselinePath = valueOf("--baseline");
const maxPrefixArg = valueOf("--max-prefix");
const dumpDir = valueOf("--dump");
const turns = Number(valueOf("--turns") ?? 2);
/** provider API 形状：openai-completions（默认）或 anthropic-messages（验缓存断点）。 */
const apiShape = valueOf("--api") ?? "openai-completions";
/** --no-addons：把两个可关的提示词附加项都关掉，验证设置项确实影响前缀。 */
const noAddons = args.includes("--no-addons");
/** --language message：把回复语言约束挪到用户消息侧（位置实验，默认 prefix）。 */
const languageInMessage = valueOf("--language") === "message";
/**
 * --probe shell:status：第一轮让假模型真的调一次多态工具，第二轮看工具结果。
 * 验证「facade → ctx.executeTool → 旧工具 → 结果回模型」整条链路（不只是请求体形状）。
 */
const probeArg = valueOf("--probe");
const probeSearchArg = valueOf("--probe-search");
const probe = (() => {
  if (probeArg) {
    const [tool, action] = probeArg.split(":");
    if (!tool || !action) {
      throw new Error("--probe expects <tool>:<action>, e.g. --probe shell:status");
    }
    return { steps: [{ tool, args: { action } }] };
  }
  if (probeSearchArg) {
    // 按需域的两步验证：先 tool_search 激活，再按声明出来的 schema 调一次该域的动作。
    const args =
      probeSearchArg === "memory" ? { action: "recall", query: "token cost" } : { action: "status" };
    return {
      domain: probeSearchArg,
      steps: [
        { tool: "tool_search", args: { query: probeSearchArg } },
        { tool: probeSearchArg, args },
      ],
    };
  }
  return undefined;
})();
const TIMEOUT_MS = 60_000;

function valueOf(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(120);
  }
  throw new Error(message);
}

function writeAgentDir(agentDir, baseUrl, apiShape = "openai-completions") {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    path.join(agentDir, "models.json"),
    `${JSON.stringify(
      {
        providers: {
          measure: {
            baseUrl,
            api: apiShape,
            apiKey: "measure-key",
            models: [{ id: "measure-1", name: "Measure 1", contextWindow: 200_000 }],
          },
        },
      },
      null,
      2
    )}\n`
  );
  writeFileSync(
    path.join(agentDir, "settings.json"),
    `${JSON.stringify(
      {
        defaultProvider: "measure",
        defaultModel: "measure-1",
        defaultProjectTrust: "always",
        cacheWarming: "off",
      },
      null,
      2
    )}\n`
  );
  writeFileSync(path.join(agentDir, "auth.json"), `${JSON.stringify({}, null, 2)}\n`);
  if (noAddons) {
    writeFileSync(
      path.join(agentDir, "desktop-settings.json"),
      `${JSON.stringify(
        {
          defaultAgentMode: "full",
          defaultToolPreset: "default",
          outputStyleGuidelines: false,
          responseLanguageGuideline: false,
        },
        null,
        2
      )}
`
    );
  }
}

function createEndpoint() {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\piforge-measure-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  }
  const dir = mkdtempSync(path.join(tmpdir(), "piforge-measure-"));
  return path.join(dir, "agent-host.sock");
}

function waitForReady(child, logs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error("host did not report ready")), TIMEOUT_MS);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    child.stdout.on("data", (chunk) => {
      logs.push(chunk.toString("utf8"));
      if (logs.join("").includes("[agent-host] ready")) finish(null);
    });
    child.stderr.on("data", (chunk) => logs.push(chunk.toString("utf8")));
    child.once("exit", (code) => finish(new Error(`host exited before ready (code ${code})`)));
    child.once("error", finish);
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
            /* ignore malformed frame */
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

/** A. PiForge 真实路径：Agent Host → agent.create → 多轮 prompt。 */
async function measureHost(recorder) {
  const baseUrl = recorder.baseUrl;
  const start = recorder.requests.length;
  if (!existsSync(hostEntry)) {
    throw new Error(`missing ${hostEntry} (run npm run build:agent-host)`);
  }
  const agentDir = mkdtempSync(path.join(tmpdir(), "piforge-measure-host-"));
  writeAgentDir(agentDir, baseUrl, apiShape);
  const endpoint = createEndpoint();
  const token = `measure-${Math.random().toString(36).slice(2)}`;
  const logs = [];
  const captured = () => recorder.requests.slice(start).map((entry) => entry.body);

  const child = spawn(process.execPath, [hostEntry], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PIFORGE_AGENT_ENDPOINT: endpoint,
      PIFORGE_AGENT_TOKEN: token,
      ...(languageInMessage ? { PIFORGE_LANGUAGE_IN_MESSAGE: "1" } : {}),
    },
  });

  try {
    await waitForReady(child, logs);
    const client = await createClient(endpoint);
    client.send({
      kind: "hello",
      protocolVersion: 1,
      token,
      client: { pid: process.pid, role: "cli" },
    });
    const hello = await client.waitFor(
      (frame) => frame.kind === "hello_ok" || frame.kind === "hello_error"
    );
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
        command: { type: "prompt", message: "measure turn 1: reply with the single word ok" },
      },
    });
    const created = await client.waitFor((frame) => frame.kind === "res" && frame.id === 1);
    if (!created.ok) throw new Error(`agent.create failed: ${JSON.stringify(created)}`);
    const sessionId = created.result.sessionId;

    await waitFor(
      () => captured().some((body) => hasTools(body)),
      "no model request with tools was captured (host mode)"
    );

    for (let turn = 2; turn <= turns; turn += 1) {
      const before = recorder.requests.length;
      client.send({
        kind: "req",
        id: 100 + turn,
        method: "agent.command",
        params: {
          sessionId,
          command: { type: "prompt", message: `measure turn ${turn}: reply ok` },
        },
      });
      await client.waitFor((frame) => frame.kind === "res" && frame.id === 100 + turn);
      await waitFor(
        () => recorder.requests.length > before,
        `turn ${turn} produced no request (host mode)`
      );
      await sleep(1200);
    }
  } finally {
    await stopChild(child);
    cleanupDir(agentDir);
    if (logs.length > 0 && process.env.PIFORGE_MEASURE_DEBUG === "1") {
      console.error(logs.join("").split("\n").slice(-20).join("\n"));
    }
  }

  return { label: "PiForge", requests: captured() };
}

/** B. pi CLI 基线：进程内直接建会话，不挂任何桌面扩展。 */
async function measurePiCli(recorder) {
  const baseUrl = recorder.baseUrl;
  const start = recorder.requests.length;
  const sdk = await import("@earendil-works/pi-coding-agent");
  const agentDir = mkdtempSync(path.join(tmpdir(), "piforge-measure-pi-"));
  writeAgentDir(agentDir, baseUrl);
  const captured = () => recorder.requests.slice(start).map((entry) => entry.body);
  let session;
  try {
    const loader = new sdk.DefaultResourceLoader({ cwd: repoRoot, agentDir });
    await loader.reload();
    const created = await sdk.createAgentSession({
      cwd: repoRoot,
      agentDir,
      resourceLoader: loader,
      tools: ["read", "bash", "edit", "write"],
    });
    session = created.session;
    await session.prompt("measure turn 1: reply with the single word ok");
    await waitFor(
      () => captured().some((body) => hasTools(body)),
      "no model request with tools was captured (pi mode)"
    );
    for (let turn = 2; turn <= turns; turn += 1) {
      const before = recorder.requests.length;
      await session.prompt(`measure turn ${turn}: reply ok`);
      await waitFor(() => recorder.requests.length > before, `turn ${turn} produced no request (pi mode)`);
      await sleep(1200);
    }
  } finally {
    try {
      await session?.destroy?.();
    } catch {
      /* ignore */
    }
    cleanupDir(agentDir);
  }
  return { label: "pi CLI", requests: captured() };
}

/** Windows 上 Host 还攥着会话文件句柄时 rmSync 会 EPERM：等进程退出再删，删不掉就留着。 */
async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.kill();
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

function cleanupDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  } catch {
    /* 临时目录留给 OS 清理，不值得让度量失败 */
  }
}

function analysesOf(requests) {
  return requests.filter((body) => hasTools(body)).map((body) => analyzeRequest({ path: "chat", bytes: 0, body }));
}

async function main() {
  const recorder = await startRecorder(probe ? { probe } : {});
  const reports = {};
  try {
    if (mode === "host" || mode === "both") {
      const { label, requests } = await measureHostWith(recorder);
      reports[label] = buildReport(label, analysesOf(requests));
    }
    if (mode === "pi" || mode === "both") {
      const { label, requests } = await measurePiWith(recorder);
      reports[label] = buildReport(label, analysesOf(requests));
    }
  } finally {
    await recorder.close().catch(() => {});
  }

  if (dumpDir) {
    mkdirSync(dumpDir, { recursive: true });
    for (const [label, report] of Object.entries(reports)) {
      const slug = label === "pi CLI" ? "pi" : "piforge";
      writeFileSync(path.join(dumpDir, `${slug}-system.md`), report.systemText ?? "");
      writeFileSync(
        path.join(dumpDir, `${slug}-tools.json`),
        `${JSON.stringify(report.rawTools ?? [], null, 2)}
`
      );
    }
  }

  const keys = Object.keys(reports);
  if (keys.length === 0) throw new Error(`unknown --mode ${mode}`);

  if (asJson) {
    process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
  } else {
    for (const key of keys) {
      if (reports[key].turns.length === 0) continue;
      printReport(reports[key]);
      console.log("");
    }
    if (reports.PiForge && reports["pi CLI"]) {
      compareReports(reports["pi CLI"], reports.PiForge);
      if (baselinePath && existsSync(baselinePath)) {
        console.log("");
        console.log("== 与基线快照比较 ==");
        try {
          compareSnapshots(JSON.parse(readFileSync(baselinePath, "utf8")), reports);
        } catch {
          console.log("  (基线不是合法 JSON，跳过)");
        }
      }
    }
  }

  if (probe) {
    console.log("");
    console.log("== 多态工具分派探针 ==");
    const steps = probe.steps;
    // 最后一条请求：既带着最后一步的工具结果，也带着「激活后」的声明集合。
    const lastRequest = recorder.requests.at(-1)?.body ?? {};
    const result = readProbeResult(lastRequest);
    const declared = declaredTools(lastRequest);
    if (!result) {
      console.error(`  ✗ ${steps.at(-1).tool} 没有产生工具结果`);
      process.exitCode = 3;
    } else {
      if (probe.domain) {
        const activated = declared.includes(probe.domain);
        console.log(
          `  ${activated ? "✓" : "✗"} tool_search("${probe.domain}") 激活后该域进入声明集合`
        );
        if (!activated) process.exitCode = 3;
      }
      console.log(
        `  ✓ ${steps.at(-1).tool} ${JSON.stringify(steps.at(-1).args)} -> toolCallId=${result.toolCallId}`
      );
      console.log(`  结果: ${result.content.split("\n")[0]}`);
      if (steps.length > 1) {
        console.log(`  首次使用该域的新增往返: ${steps.length - 1} 次`);
      }
    }
  }

  if (maxPrefixArg) {
    const budget = Number(maxPrefixArg);
    const value = reports.PiForge?.turns?.[0]?.prefixTokens ?? 0;
    if (Number.isFinite(budget) && value > budget) {
      console.error(`measure-prefix: prefix ${value} tok > budget ${budget} tok`);
      process.exitCode = 2;
    }
  }
}

/** 两种模式共用同一个 HTTP 记录器：用切片下标隔离各自产生的请求体。 */
async function measureHostWith(recorder) {
  return measureHost(recorder);
}

async function measurePiWith(recorder) {
  return measurePiCli(recorder);
}

function compareSnapshots(snapshot, reports) {
  const before = snapshot.PiForge?.turns?.[0] ?? snapshot.turns?.[0];
  const after = reports.PiForge?.turns?.[0];
  if (!before || !after) return;
  const pct = (from, to) => (from === 0 ? "n/a" : `${(((to - from) / from) * 100).toFixed(1)}%`);
  console.log(`  system: ${before.systemTokens} → ${after.systemTokens} tok (${pct(before.systemTokens, after.systemTokens)})`);
  console.log(`  tools:  ${before.toolsTokens} → ${after.toolsTokens} tok (${pct(before.toolsTokens, after.toolsTokens)})`);
  console.log(`  prefix: ${before.prefixTokens} → ${after.prefixTokens} tok (${pct(before.prefixTokens, after.prefixTokens)})`);
}

await main();
