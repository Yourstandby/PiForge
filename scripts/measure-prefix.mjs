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
 *   node scripts/measure-prefix.mjs --mode host --summary       # 只打几行决策数字（省上下文）
 *   node scripts/measure-prefix.mjs --codemode off              # 关掉 codemode，工具照常声明
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
  formatSummaryLines,
  hasTools,
  declaredTools,
  printReport,
  readProbeResult,
  startRecorder,
  summarizeCache,
} from "./lib/prefix-measure.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hostEntry = process.env.PIFORGE_HOST_ENTRY
  ? path.resolve(process.env.PIFORGE_HOST_ENTRY)
  : path.join(repoRoot, "agent-host", "dist", "agent-host", "index.js");

const args = process.argv.slice(2);
const asJson = args.includes("--json");
/** --summary：只打决策要用的几行数字（完整报告走 --json / --dump）。 */
const summaryOnly = args.includes("--summary");
const mode = valueOf("--mode") ?? "both";
const baselinePath = valueOf("--baseline");
const maxPrefixArg = valueOf("--max-prefix");
/**
 * `--codemode off|on|only`：写进 desktop-settings.json 的 codemodeEnabled / codemodeMode。
 * 默认（不传）＝不写该文件，走应用默认值（当前是开启 + `only`：普通工具不声明给模型）。
 * 量「按需域 / 工具声明」这类护栏时必须传 `off`，否则声明集合里本来就没有普通工具。
 */
const codemodeArg = valueOf("--codemode");
if (codemodeArg !== undefined && !["off", "on", "only"].includes(codemodeArg)) {
  throw new Error("--codemode expects off | on | only");
}
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
/** 缓存模拟 TTL（默认 5 分钟，与 Anthropic short retention 一致）。 */
const cacheTtlMs = Number(valueOf("--cache-ttl-ms") ?? 300_000);
/** 两轮之间的停顿（模拟用户思考），用于观察 TTL 与保活。 */
const pauseMs = Number(valueOf("--pause-ms") ?? 0);
/** 打印逐请求 input / cacheRead / cacheCreation 表。 */
const cacheStats = args.includes("--cache-stats");
/** 第一轮后销毁并重新打开会话，触发「恢复时首轮预热」。 */
const resumeCheck = args.includes("--resume");
/** 缓存保活模式：默认 off（度量前缀用），观察保活时传 idle / streaming。 */
const cacheWarmingMode = valueOf("--cache-warming") ?? "off";
/** pi 只在预计省钱 >= $0.05 时保活；这个开关抬高假模型价格以验证保活机制本身。 */
const cacheEconForce = args.includes("--cache-econ-force");
/** 稳定段命中率下限（默认 0 = 不检查）。smoke 用 90。 */
const minHitRate = Number(valueOf("--assert-hit-rate") ?? 0);
/** 稳定段每轮未缓存 input 的中位数上限（0 = 不检查）。 */
const maxMedianInput = Number(valueOf("--max-median-input") ?? 0);
/** 把每条请求体写到目录里（排查 resume 回放字段、去重实际返回内容）。 */
const dumpRequestsDir = valueOf("--dump-requests");
/** 校验发送给模型的 transcript 只带模型需要的字段（不带 details/usage/UI 元数据）。 */
const assertLeanTranscript = args.includes("--assert-lean-transcript");
/** 用设置项（desktop-settings.json 的 onDemandDomains）驱动按需域，而不是环境变量。 */
const onDemandSettings = valueOf("--on-demand-settings");
/** 断言某个工具在第一条会话请求里被声明 / 未被声明。 */
const assertDeclared = valueOf("--assert-declared");
const assertUndeclared = valueOf("--assert-undeclared");
/** 每个域探针用真实存在的动作与参数（否则会在参数校验处失败，测不到分派链路）。 */
const PROBE_ARGS = {
  memory: { action: "recall", query: "token cost" },
  orchestrator: { action: "status" },
  fleet: { action: "status" },
  browser: { action: "read" },
  shell: { action: "run", command: "echo piforge-probe" },
};

const probe = (() => {
  if (probeArg) {
    const [tool, action] = probeArg.split(":");
    if (!tool || !action) {
      throw new Error("--probe expects <tool>:<action>, e.g. --probe shell:status");
    }
    const preset = PROBE_ARGS[tool];
    const args = preset && preset.action === action ? preset : { action };
    return { steps: [{ tool, args }] };
  }
  if (probeSearchArg) {
    // 按需域的两步验证：先 tool_search 激活，再按声明出来的 schema 调一次该域的动作。
    const args = PROBE_ARGS[probeSearchArg] ?? { action: "status" };
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

/** 等会话空闲（不 streaming），避免下一条 prompt 被 "Session is streaming" 拒掉。 */
async function waitIdle(client, sessionId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    client.send({ kind: "req", id: 950, method: "agent.state", params: { sessionId } });
    const frame = await client.waitFor((entry) => entry.kind === "res" && entry.id === 950);
    if (frame?.result?.state?.isStreaming !== true) return true;
    await sleep(150);
  }
  return false;
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
            models: [
              {
                id: "measure-1",
                name: "Measure 1",
                contextWindow: 200_000,
                maxTokens: 16_384,
                // pi 的 CacheWarmer 靠 cost + promptCache 判断「保活是否划算」；
                // 缺任一项它就静默停掉（economics unavailable）。
                cost: {
                  input: cacheEconForce ? 500 : 3,
                  output: cacheEconForce ? 2000 : 15,
                  cacheRead: cacheEconForce ? 50 : 0.3,
                  cacheWrite: cacheEconForce ? 625 : 3.75,
                },
                // promptCache 单位是秒（与内置 Anthropic 模型一致：short=300）。
                promptCache: { short: Math.max(11, Math.round(cacheTtlMs / 1000)), long: 3600 },
              },
            ],
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
        cacheWarming: cacheWarmingMode,
      },
      null,
      2
    )}\n`
  );
  writeFileSync(path.join(agentDir, "auth.json"), `${JSON.stringify({}, null, 2)}\n`);
  // 三项开关合并写一次：分开写会互相覆盖（后一次写把前一次的字段吃掉）。
  const desktopSettings = { defaultAgentMode: "full", defaultToolPreset: "default" };
  if (onDemandSettings !== undefined) {
    desktopSettings.onDemandDomains = onDemandSettings
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (noAddons) {
    desktopSettings.outputStyleGuidelines = false;
    desktopSettings.responseLanguageGuideline = false;
  }
  if (codemodeArg === "off") {
    desktopSettings.codemodeEnabled = false;
  } else if (codemodeArg !== undefined) {
    desktopSettings.codemodeEnabled = true;
    desktopSettings.codemodeMode = codemodeArg;
  }
  if (
    onDemandSettings !== undefined ||
    noAddons ||
    codemodeArg !== undefined
  ) {
    writeFileSync(
      path.join(agentDir, "desktop-settings.json"),
      `${JSON.stringify(desktopSettings, null, 2)}
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
  let state = null;
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

    if (probe) {
      // 探针没跑完就发下一轮 prompt 会打断工具循环（模型还在等 tool_search 的结果）。
      await waitFor(() => recorder.probeDone(), "probe did not finish");
      await waitIdle(client, sessionId);
    }

    if (resumeCheck) {
      // 恢复会话 → Host 应在装载落定后立刻发一次 maxTokens:1 的前缀预热。
      client.send({ kind: "req", id: 90, method: "agent.state", params: { sessionId } });
      const stateFrame = await client.waitFor((frame) => frame.kind === "res" && frame.id === 90);
      const filePath = stateFrame?.result?.state?.sessionFile;
      if (!filePath) throw new Error("resume check: no sessionFile in state");
      client.send({ kind: "req", id: 91, method: "agent.destroy", params: { sessionId } });
      await client.waitFor((frame) => frame.kind === "res" && frame.id === 91);
      const warmBefore = recorder.requests.filter((entry) => entry.cache?.kind === "warm").length;
      client.send({
        kind: "req",
        id: 92,
        method: "agent.ensure",
        params: { sessionId, filePath, cwd: repoRoot },
      });
      await client.waitFor((frame) => frame.kind === "res" && frame.id === 92);
      await sleep(1500);
      const warmAfter = recorder.requests.filter((entry) => entry.cache?.kind === "warm").length;
      if (warmAfter > warmBefore) {
        console.log("  ✓ 恢复会话时发出了预热请求（maxTokens=1）");
      } else {
        client.send({ kind: "req", id: 93, method: "agent.state", params: { sessionId } });
        const after = await client.waitFor((frame) => frame.kind === "res" && frame.id === 93);
        const prewarm = after?.result?.state?.cacheWarming?.prewarm;
        console.warn(
          `  ! 恢复会话未发出预热：${prewarm ? `${prewarm.sent ? "sent" : "skipped"} (${prewarm.reason})` : "no prewarm record"}`
        );
      }
    }

    for (let turn = 2; turn <= turns; turn += 1) {
      await waitIdle(client, sessionId);
      if (pauseMs > 0) await sleep(pauseMs);
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
      const ack = await client.waitFor((frame) => frame.kind === "res" && frame.id === 100 + turn);
      if (ack?.ok === false) {
        // 偶发：上一条 prompt 还在收尾 → 等空闲再试一次。
        await waitIdle(client, sessionId);
        const retryBefore = recorder.requests.length;
        client.send({
          kind: "req",
          id: 200 + turn,
          method: "agent.command",
          params: { sessionId, command: { type: "prompt", message: `measure turn ${turn}: reply ok` } },
        });
        await client.waitFor((frame) => frame.kind === "res" && frame.id === 200 + turn);
        await waitFor(
          () => recorder.requests.length > retryBefore,
          `turn ${turn} produced no request after retry (host mode)`
        );
        await sleep(1200);
        continue;
      }
      await waitFor(
        () => recorder.requests.length > before,
        `turn ${turn} produced no request (host mode)`
      );
      await sleep(1200);
    }

    // 最后读一次 Host 状态：缓存保活 + 前缀审计都在 get_state 里。
    client.send({ kind: "req", id: 900, method: "agent.state", params: { sessionId } });
    const stateFrame = await client
      .waitFor((entry) => entry.kind === "res" && entry.id === 900)
      .catch(() => null);
    state = stateFrame?.result?.state ?? null;
  } finally {
    await stopChild(child);
    cleanupDir(agentDir);
    if (logs.length > 0 && process.env.PIFORGE_MEASURE_DEBUG === "1") {
      console.error(logs.join("").split("\n").slice(-20).join("\n"));
    }
  }

  return { label: "PiForge", requests: captured(), state };
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
  const recorder = await startRecorder({ ...(probe ? { probe } : {}), cacheTtlMs });
  const reports = {};
  let hostState = null;
  try {
    if (mode === "host" || mode === "both") {
      const { label, requests, state } = await measureHostWith(recorder);
      hostState = state;
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
  } else if (summaryOnly) {
    for (const line of formatSummaryLines(reports, {
      ...(cacheStats ? { cache: summarizeCache(recorder.requests) } : {}),
      ...(hostState?.prefixAudit ? { audit: hostState.prefixAudit } : {}),
    })) {
      console.log(line);
    }
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
    // 找承载「最后一步工具结果」的那条请求：它同时带着激活后的声明集合。
    const stepCount = steps.length;
    const probeRequest =
      [...recorder.requests]
        .reverse()
        .find(
          (entry) =>
            Array.isArray(entry.body?.messages) &&
            entry.body.messages.filter((message) => message?.role === "tool").length >= stepCount
        )?.body ?? {};
    const result = readProbeResult(probeRequest);
    const declared = declaredTools(probeRequest);
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
        // 主判据用 Host 的棘轮审计（它知道每一轮，且能区分"按需域首次激活"）。
        const audit = hostState?.prefixAudit;
        const hashes = reports.PiForge.turns.map((turn) => turn.prefixHash);
        const hashStable = hashes.length >= 2 && hashes.at(-1) === hashes.at(-2);
        if (audit) {
          const ok = audit.unexpectedChanges === 0;
          console.log(
            `  ${ok ? "✓" : "✗"} 前缀棘轮: turns=${audit.turns} stable=${audit.stableTurns} expectedChanges=${audit.expectedChanges} unexpectedChanges=${audit.unexpectedChanges}` +
              (audit.lastChange && !audit.lastChange.expected
                ? ` | unexpected: +${audit.lastChange.toolsAdded.join(",")} -${audit.lastChange.toolsRemoved.join(",")} sections=${audit.lastChange.sectionsChanged.join(",")} reordered=${audit.lastChange.toolsReordered}`
                : "")
          );
          if (!ok) process.exitCode = 5;
        }
        if (hashStable) {
          console.log(`  ✓ 激活后连续两轮 prefixHash 一致: ${hashes.slice(-2).join(" / ")}`);
        } else {
          console.log(
            `  · 最后两轮 hash 不同（激活发生在其中一轮，见上面的棘轮审计）: ${hashes.slice(-2).join(" / ")}`
          );
        }
      }
    }
  }

  // tool_search 的名字对齐断言：结果里列的每个名字，都必须是下一条请求真正声明的工具。
  {
    const mismatches = [];
    for (const entry of recorder.requests) {
      const body = entry.body ?? {};
      const declared = new Set(
        (Array.isArray(body.tools) ? body.tools : []).map((tool) =>
          String((tool?.function ?? tool)?.name ?? "")
        )
      );
      const messages = Array.isArray(body.messages) ? body.messages : [];
      for (const message of messages) {
        if (message?.role !== "tool") continue;
        const text = typeof message.content === "string" ? message.content : "";
        if (!/^Loaded \d+ tool/m.test(text.trim())) continue;
        const names = [...text.matchAll(/^- ([A-Za-z0-9_.:-]+):/gm)].map((match) => match[1]);
        for (const name of names) {
          if (!declared.has(name)) mismatches.push({ name, declared: [...declared] });
        }
      }
    }
    console.log("");
    if (mismatches.length === 0) {
      console.log("tool_search 命名对齐: ✓ 返回的名字都在下一条请求的声明集合里");
    } else {
      console.error(
        `tool_search 命名对齐: ✗ ${mismatches.map((entry) => entry.name).join(", ")} 未在声明集合中`
      );
      process.exitCode = 9;
    }
  }

  if (dumpRequestsDir) {
    mkdirSync(dumpRequestsDir, { recursive: true });
    recorder.requests.forEach((entry, index) => {
      writeFileSync(
        path.join(dumpRequestsDir, `request-${String(index + 1).padStart(2, "0")}.json`),
        `${JSON.stringify(entry.body, null, 2)}
`
      );
    });
    console.log(`请求体已写入 ${dumpRequestsDir}（${recorder.requests.length} 条）`);
  }

  if (cacheStats) {
    console.log("");
    console.log("== 逐请求缓存账本（模拟 Anthropic prompt cache：最长公共前缀 + TTL） ==");
    console.log(
      `${"#".padStart(3)} ${"kind".padEnd(5)} ${"maxTok".padStart(6)} ${"input".padStart(6)} ${"cacheRead".padStart(9)} ${"cacheCreate".padStart(11)}`
    );
    recorder.requests.forEach((entry, index) => {
      const c = entry.cache;
      if (!c) return;
      const input = c.totalTokens - c.cacheReadTokens - c.cacheCreationTokens;
      console.log(
        `${String(index + 1).padStart(3)} ${String(c.kind).padEnd(5)} ${String(c.maxTokens ?? "-").padStart(6)} ${String(input).padStart(6)} ${String(c.cacheReadTokens).padStart(9)} ${String(c.cacheCreationTokens).padStart(11)}`
      );
    });
    if (hostState?.cacheWarming) {
      const cw = hostState.cacheWarming;
      console.log("");
      console.log(
        `缓存保活: mode=${cw.mode} state=${cw.state}${cw.reason ? ` reason=${cw.reason}` : ""}${
          cw.prewarm ? ` prewarm=${cw.prewarm.sent ? "sent" : `skipped(${cw.prewarm.reason})`}` : ""
        }`
      );
    }
    if (hostState?.prefixAudit) {
      const audit = hostState.prefixAudit;
      console.log(
        `前缀审计: turns=${audit.turns} stable=${audit.stableTurns} expectedChanges=${audit.expectedChanges} unexpectedChanges=${audit.unexpectedChanges}`
      );
      if (audit.unexpectedChanges > 0) {
        console.error("  ✗ 出现非预期前缀变化（相邻两轮本应字节一致）");
        process.exitCode = 4;
      }
    }
  }

  if (assertDeclared || assertUndeclared) {
    const firstSessionRequest = recorder.requests.find(
      (entry) => Array.isArray(entry.body?.tools) && entry.body.tools.length > 0
    );
    const declared = new Set(
      (firstSessionRequest?.body?.tools ?? []).map((tool) => String((tool?.function ?? tool)?.name ?? ""))
    );
    console.log("");
    if (assertDeclared) {
      const ok = declared.has(assertDeclared);
      console.log(`${ok ? "✓" : "✗"} ${assertDeclared} 在默认声明集合里`);
      if (!ok) process.exitCode = 10;
    }
    if (assertUndeclared) {
      const ok = !declared.has(assertUndeclared);
      console.log(`${ok ? "✓" : "✗"} ${assertUndeclared} 默认不声明（按需）`);
      if (!ok) process.exitCode = 10;
    }
  }

  if (assertLeanTranscript) {
    // 只允许这些键：消息级 role/content/tool_calls/tool_call_id/name，块级 type/text 等。
    const allowedMessageKeys = new Set([
      "role",
      "content",
      "tool_calls",
      "tool_call_id",
      "name",
      "tool_call",
      "reasoning_content",
    ]);
    const forbidden = new Set([
      "details",
      "usage",
      "customType",
      "display",
      "entryId",
      "timestamp",
      "cost",
      "cacheRead",
      "cacheWrite",
      "thinkingSignature",
    ]);
    const leaks = [];
    for (const entry of recorder.requests) {
      const messages = Array.isArray(entry.body?.messages) ? entry.body.messages : [];
      for (const message of messages) {
        for (const key of Object.keys(message ?? {})) {
          if (forbidden.has(key)) leaks.push(`message.${key}`);
          else if (!allowedMessageKeys.has(key)) leaks.push(`message.${key}`);
        }
      }
    }
    console.log("");
    console.log(`transcript 字段裁剪: ${leaks.length === 0 ? "✓ 只含模型需要的字段" : `✗ 泄漏 ${[...new Set(leaks)].join(", ")}`}`);
    if (leaks.length > 0) process.exitCode = 7;
  }

  if (maxMedianInput > 0) {
    const turnsWithCache = recorder.requests
      .map((entry) => entry.cache)
      .filter((cache) => cache && cache.kind === "turn");
    const stable = turnsWithCache.filter(
      (cache, position) => position > 0 && cache.cacheCreationTokens <= Math.max(200, cache.totalTokens * 0.2)
    );
    // recorder 里没有「provider 未缓存 input」的概念：每轮真正新增的 token
    // 就是 cacheCreationTokens（新消息 + 任何前缀重写）。
    const inputs = stable.map((cache) => cache.cacheCreationTokens).sort((a, b) => a - b);
    const median =
      inputs.length === 0
        ? 0
        : inputs.length % 2 === 1
          ? inputs[(inputs.length - 1) / 2]
          : Math.round((inputs[inputs.length / 2 - 1] + inputs[inputs.length / 2]) / 2);
    console.log(`稳定段每轮新增 token 中位数: ${median} tok（cacheCreation）`);
    if (median > maxMedianInput) {
      console.error(`  ✗ 超过上限 ${maxMedianInput}`);
      process.exitCode = 8;
    }
  }

  if (minHitRate > 0) {
    // 稳定段 = 跳过首轮（冷启动）、warm 请求，以及 cacheCreate 明显偏大的轮次（前缀变化）。
    const turnsWithCache = recorder.requests
      .map((entry, index) => ({ index, cache: entry.cache }))
      .filter((entry) => entry.cache && entry.cache.kind === "turn");
    const stable = turnsWithCache.filter(
      (entry, position) =>
        position > 0 && entry.cache.cacheCreationTokens <= Math.max(200, entry.cache.totalTokens * 0.2)
    );
    const read = stable.reduce((sum, entry) => sum + entry.cache.cacheReadTokens, 0);
    const created = stable.reduce((sum, entry) => sum + entry.cache.cacheCreationTokens, 0);
    const rate = read + created > 0 ? (read / (read + created)) * 100 : 0;
    console.log("");
    console.log(`稳定段 cacheRead 命中率: ${rate.toFixed(1)}% (${stable.length} 轮)`);
    if (rate < minHitRate) {
      console.error(`  ✗ 低于阈值 ${minHitRate}%`);
      process.exitCode = 6;
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
