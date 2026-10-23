/**
 * 前缀度量工具库（`scripts/measure-prefix.mjs` 的实现）。
 *
 * 三块能力：
 *   1. `startRecorder()`：本地「记录型 provider」，收下真实请求体、回固定的假 SSE
 *      （OpenAI chat-completions 与 Anthropic messages 两种形状）；
 *   2. `analyzeRequest()`：把请求体拆成 system / tools / 历史三段并算 token；
 *   3. `printReport()` / `compareReports()`：人读报告与基线对比。
 *
 * 口径：与 `lib/live-usage.ts` 一致的估算（CJK 1 字 ≈ 1 token，其他 4 字符 ≈ 1）。
 * 只用于**相对比较**（同一口径下的前后差值），不冒充厂商分词器。
 */
import { createHash } from "node:crypto";
import { createServer } from "node:http";

const CJK_RE = /[\u3000-\u9fff\uff00-\uffef]/;

/** 与 lib/live-usage.ts 完全一致的估算口径。 */
export function estimateTokens(text) {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (CJK_RE.test(char)) cjk += 1;
    else other += 1;
  }
  return Math.max(0, Math.round(cjk + other / 4));
}

/** 核心工具 = pi 自带默认集合；其余一律算「PiForge 附加」。 */
export const CORE_TOOLS = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function sha(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

const SSE_END = "data: [DONE]\n\n";

function openAIChunk({ id, model, delta, finishReason, usage }) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
    ...(usage ? { usage } : {}),
  })}\n\n`;
}

function writeAnthropicStream(res, { model, index }) {
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("message_start", {
    type: "message_start",
    message: {
      id: `msg_measure_${index}`,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  });
  send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } });
  send("content_block_stop", { type: "content_block_stop", index: 0 });
  send("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 1 },
  });
  send("message_stop", { type: "message_stop" });
  res.end();
}

/**
 * 起一个记录型 provider：任何 OpenAI/Anthropic 形状的 POST 都收下并回假数据。
 *
 * @param {{ probe?: { steps: Array<{ tool: string, args: Record<string, unknown> }> } }} [options]
 *   probe.steps：按顺序让假模型发起真实工具调用，每一步之后回一次结果，最后回文本。
 *   用来验证「tool_search 激活 → 下一轮按 schema 调用 → ctx.executeTool → 旧工具」
 *   这条链路真的通（度量本身只看请求体，不看工具结果）。
 */
export async function startRecorder(options = {}) {
  const probeSteps = options.probe?.steps ?? [];
  const requests = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
      requests.push({ path: req.url, bytes: raw.length, body });
      if (!req.url || !/chat\/completions|messages/.test(req.url)) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "measure-prefix: unexpected path" } }));
        return;
      }
      const anthropic = /\/messages/.test(req.url ?? "");
      const model = body?.model ?? "measure-1";
      const id = `chatcmpl-measure-${requests.length}`;
      const usage = {
        prompt_tokens: 1,
        completion_tokens: 2,
        total_tokens: 3,
        prompt_tokens_details: { cached_tokens: 0 },
      };
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      if (anthropic) {
        writeAnthropicStream(res, { model, index: requests.length });
        return;
      }
      const messages = Array.isArray(body?.messages) ? body.messages : [];
      const toolResults = messages.filter((message) => message?.role === "tool").length;
      const step = probeSteps[toolResults];
      if (step) {
        res.write(openAIChunk({ id, model, delta: { role: "assistant", content: "" } }));
        res.write(
          openAIChunk({
            id,
            model,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: `call_probe_${toolResults + 1}`,
                  type: "function",
                  function: { name: step.tool, arguments: JSON.stringify(step.args) },
                },
              ],
            },
          })
        );
        res.write(openAIChunk({ id, model, delta: {}, finishReason: "tool_calls", usage }));
        res.write(SSE_END);
        res.end();
        return;
      }
      res.write(openAIChunk({ id, model, delta: { role: "assistant", content: "" } }));
      res.write(openAIChunk({ id, model, delta: { content: "ok" } }));
      res.write(openAIChunk({ id, model, delta: {}, finishReason: "stop", usage }));
      res.write(SSE_END);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((done) => server.close(done)),
  };
}

function readTools(body) {
  const raw = Array.isArray(body?.tools) ? body.tools : [];
  return raw.map((tool) => {
    const fn = tool?.function ?? tool;
    const name = String(fn?.name ?? "?");
    const serialized = canonicalJson(tool);
    return {
      name,
      chars: serialized.length,
      tokens: estimateTokens(serialized),
      core: CORE_TOOLS.has(name),
    };
  });
}

function hasCacheControl(value) {
  return Boolean(value && typeof value === "object" && "cache_control" in value);
}

function countMessageBreakpoints(messages) {
  let count = 0;
  for (const message of messages) {
    if (hasCacheControl(message)) count += 1;
    const content = message?.content;
    if (Array.isArray(content)) {
      for (const block of content) if (hasCacheControl(block)) count += 1;
    }
  }
  return count;
}

export function hasTools(body) {
  return Array.isArray(body?.tools) && body.tools.length > 0;
}

/** 某一轮请求声明的工具名。 */
export function declaredTools(body) {
  return (Array.isArray(body?.tools) ? body.tools : []).map(
    (tool) => String((tool?.function ?? tool)?.name ?? "")
  );
}

/** 从请求体里捞出最后一次工具执行结果（验证分派链路用）。 */
export function readProbeResult(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const results = messages.filter((message) => message?.role === "tool");
  if (results.length === 0) return null;
  const last = results[results.length - 1];
  const content = Array.isArray(last.content)
    ? last.content.map((block) => block?.text ?? "").join("")
    : typeof last.content === "string"
      ? last.content
      : JSON.stringify(last.content ?? {});
  return { toolCallId: last.tool_call_id ?? null, content: String(content).slice(0, 400) };
}

/** 把一个请求体拆成可比较、可断言的结构。 */
export function analyzeRequest(request) {
  const body = request.body ?? {};
  const tools = readTools(body).sort((a, b) => b.tokens - a.tokens);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  // OpenAI 形状把 system 放在 messages[0]；Anthropic 形状是顶层 `system`。
  const topLevelSystem = body?.system;
  const systemText =
    typeof topLevelSystem === "string"
      ? topLevelSystem
      : Array.isArray(topLevelSystem)
        ? topLevelSystem
            .map((block) => (typeof block === "string" ? block : String(block?.text ?? "")))
            .join("\n")
        : messages
            .filter((message) => message?.role === "system")
            .map((message) =>
              typeof message.content === "string" ? message.content : JSON.stringify(message.content)
            )
            .join("\n");
  const toolsTokens = tools.reduce((sum, tool) => sum + tool.tokens, 0);
  const coreToolsTokens = tools
    .filter((tool) => tool.core)
    .reduce((sum, tool) => sum + tool.tokens, 0);
  const serializedBody = JSON.stringify(body);
  const prefixHash = sha(
    canonicalJson({
      system: systemText,
      tools: Array.isArray(body.tools) ? body.tools : [],
    })
  );
  return {
    path: request.path,
    bytes: request.bytes,
    systemText,
    messages: messages.length,
    messageRoles: messages.map((message) => message?.role ?? "?"),
    systemChars: systemText.length,
    systemTokens: estimateTokens(systemText),
    tools,
    rawTools: Array.isArray(body.tools) ? body.tools : [],
    toolsCount: tools.length,
    toolsTokens,
    coreToolsTokens,
    extensionToolsTokens: toolsTokens - coreToolsTokens,
    prefixTokens: estimateTokens(systemText) + toolsTokens,
    bodyTokens: estimateTokens(serializedBody),
    /**
     * 缓存断点布局（Anthropic 形状才有；OpenAI 形状恒为 false/0）。
     * 用来验证「断点落在 tools 末尾 + system 末尾 + 最后一条消息」在合并工具后仍成立。
     */
    cacheBreakpoints: {
      system: hasCacheControl(
        Array.isArray(topLevelSystem) ? topLevelSystem[topLevelSystem.length - 1] : topLevelSystem
      ),
      tools:
        Array.isArray(body.tools) && body.tools.length > 0
          ? hasCacheControl(body.tools[body.tools.length - 1])
          : false,
      messages: countMessageBreakpoints(messages),
      total: (serializedBody.match(/"cache_control"/g) ?? []).length,
    },
    prefixHash,
  };
}

export function buildReport(label, analyses) {
  const turns = analyses.map((analysis, index) => ({ turn: index + 1, label, ...analysis }));
  const first = turns[0];
  const prefixChanged = turns.length > 1 && turns[1].prefixHash !== first.prefixHash;
  return {
    generatedAt: new Date().toISOString(),
    label,
    turns: turns.map((turn) => ({
      turn: turn.turn,
      messages: turn.messages,
      roles: turn.messageRoles,
      systemChars: turn.systemChars,
      systemTokens: turn.systemTokens,
      toolsCount: turn.toolsCount,
      toolsTokens: turn.toolsTokens,
      coreToolsTokens: turn.coreToolsTokens,
      extensionToolsTokens: turn.extensionToolsTokens,
      prefixTokens: turn.prefixTokens,
      bodyTokens: turn.bodyTokens,
      cacheBreakpoints: turn.cacheBreakpoints,
      prefixHash: turn.prefixHash,
    })),
    tools: first.tools,
    systemText: first.systemText,
    rawTools: first.rawTools,
    prefixChangedBetweenTurns: prefixChanged,
    invalidatedOnPrefixChange: prefixChanged ? first.bodyTokens : 0,
    estimator: "cjk=1 token/char, other=4 chars/token (identical to lib/live-usage.ts)",
  };
}

export function printReport(report) {
  const first = report.turns[0];
  console.log(`== ${report.label}：静态前缀（第一轮请求体） ==`);
  console.log(`system prompt: ${first.systemChars} 字符 ≈ ${first.systemTokens} tok`);
  console.log(
    `tools: ${first.toolsCount} 个 ≈ ${first.toolsTokens} tok（核心 ${first.coreToolsTokens} / 附加 ${first.extensionToolsTokens}）`
  );
  console.log(`前缀合计 ≈ ${first.prefixTokens} tok；整条请求体 ≈ ${first.bodyTokens} tok`);
  if (first.cacheBreakpoints?.total > 0) {
    console.log(
      `cache_control 断点: system=${first.cacheBreakpoints.system ? "✓" : "✗"} tools=${first.cacheBreakpoints.tools ? "✓" : "✗"} messages=${first.cacheBreakpoints.messages} (total ${first.cacheBreakpoints.total})`
    );
  }
  console.log("");
  console.log("-- 每个工具（按成本降序） --");
  for (const tool of report.tools) {
    console.log(
      `  ${tool.name.padEnd(28)} ${String(tool.tokens).padStart(6)} tok${tool.core ? "" : "  [附加]"}`
    );
  }
  if (report.turns.length > 1) {
    console.log("");
    console.log("-- 逐轮 --");
    for (const turn of report.turns) {
      console.log(
        `  turn ${turn.turn}: messages=${turn.messages} prefix=${turn.prefixTokens} tok body=${turn.bodyTokens} tok hash=${turn.prefixHash}`
      );
    }
    console.log(
      report.prefixChangedBetweenTurns
        ? `  !! 前缀在两轮之间变化：约 ${report.invalidatedOnPrefixChange} tok 的历史缓存作废`
        : "  前缀稳定：两轮 system prompt + tools 字节一致（缓存可复用）"
    );
  }
}

/**
 * system prompt 的「多出来那部分」：按行做多重集差，再把新增行归到所属 `##` 小节。
 * 小节之外的散行（pi 的 `<tools>` 清单、guidelines 列表）按类别归组。
 */
export function diffSystemPrompts(baseText, nextText) {
  const count = (text) => {
    const map = new Map();
    for (const line of String(text ?? "").split("\n")) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const base = count(baseText);
  const groups = new Map();
  let section = "(no section)";
  let inTools = false;
  let inAddendum = false;
  const groupFor = (line) => {
    if (section !== "(no section)") return section;
    if (inAddendum) return "addendum";
    if (inTools || /^-\s+[a-z][a-z0-9_]*:\s/.test(line.trim())) return "tool 一行简介";
    return "guidelines";
  };
  for (const line of String(nextText ?? "").split("\n")) {
    if (line.startsWith("## ")) {
      section = line.replace(/^##\s*/, "");
      continue;
    }
    if (line.trim() === "<tools>") inTools = true;
    if (line.trim() === "</tools>") inTools = false;
    if (line.trim() === "<addendum>") inAddendum = true;
    const seen = base.get(line) ?? 0;
    if (seen > 0) {
      base.set(line, seen - 1);
      continue;
    }
    if (line.trim() === "</addendum>") inAddendum = false;
    const key = groupFor(line);
    const entry = groups.get(key) ?? { section: key, tokens: 0, lines: [] };
    entry.tokens += estimateTokens(line) || 0;
    if (line.trim()) entry.lines.push(line.trim().slice(0, 160));
    groups.set(key, entry);
  }
  return [...groups.values()]
    .map((entry) => ({
      section: entry.section,
      tokens: entry.tokens,
      lines: entry.lines.slice(0, 8),
      moreLines: Math.max(0, entry.lines.length - 8),
    }))
    .sort((a, b) => b.tokens - a.tokens);
}

function pct(from, to) {
  if (!from) return "n/a";
  return `${(((to - from) / from) * 100).toFixed(1)}%`;
}

/** 两个报告对比：pi 基线 vs PiForge。 */
export function compareReports(base, next) {
  const a = base.turns[0];
  const b = next.turns[0];
  const rows = [
    ["system prompt ≈tok", a.systemTokens, b.systemTokens],
    ["tools ≈tok", a.toolsTokens, b.toolsTokens],
    ["  其中新增工具 ≈tok", a.extensionToolsTokens, b.extensionToolsTokens],
    ["静态前缀 ≈tok", a.prefixTokens, b.prefixTokens],
    ["工具个数", a.toolsCount, b.toolsCount],
  ];
  console.log("");
  console.log(`== 对比：${base.label} → ${next.label} ==`);
  console.log(
    `${"指标".padEnd(22)} ${String(base.label).padStart(10)} ${String(next.label).padStart(10)} ${"Δ".padStart(9)}`
  );
  for (const [name, from, to] of rows) {
    console.log(
      `${name.padEnd(22)} ${String(from).padStart(10)} ${String(to).padStart(10)} ${pct(from, to).padStart(9)}`
    );
  }
  const sections = diffSystemPrompts(base.systemText, next.systemText);
  const extraSystemTokens = b.systemTokens - a.systemTokens;
  console.log("");
  console.log(`-- 多出来的 system prompt 段落（合计 ≈ ${extraSystemTokens} tok） --`);
  for (const section of sections) {
    console.log(`  [${String(section.tokens).padStart(5)} tok] ${section.section}`);
    for (const line of section.lines.slice(0, 3)) console.log(`      · ${line}`);
    if (section.moreLines > 0) console.log(`      · …还有 ${section.moreLines} 行`);
  }
  return {
    systemDelta: pct(a.systemTokens, b.systemTokens),
    toolsDelta: pct(a.toolsTokens, b.toolsTokens),
    prefixDelta: pct(a.prefixTokens, b.prefixTokens),
    extraSystemTokens,
    extraToolsTokens: b.toolsTokens - a.toolsTokens,
    extraPrefixTokens: b.prefixTokens - a.prefixTokens,
    extraSections: sections,
  };
}
