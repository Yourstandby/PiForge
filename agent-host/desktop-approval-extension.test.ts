import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "./sdk-adapter.ts";
import { PLAN_MODE_SYSTEM_PROMPT, RESPONSE_LANGUAGE_PROMPT } from "../lib/approval-policy.ts";
import { createDesktopApprovalFactory } from "./desktop-approval-extension.ts";
import { STATIC_CWD_SECTION } from "./prompt-prefix.ts";

type Handler = (event: unknown, ctx?: unknown) => unknown;

function setup(mode: "plan" | "ask" | "full") {
  const handlers = new Map<string, Handler>();
  const activeTools: string[][] = [];
  const pi = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    setActiveTools: (names: string[]) => activeTools.push(names),
    getAllTools: () => [],
    getActiveTools: () => [],
    registerTool: () => {},
  } as unknown as ExtensionAPI;

  const modeRef = { current: mode, toolPreset: "default" as const };
  createDesktopApprovalFactory(modeRef)(pi);
  return { handlers, activeTools, modeRef };
}

function beforeAgentStartEvent(appendSystemPrompt = "") {
  return {
    type: "before_agent_start",
    prompt: "add a button",
    get systemPrompt() {
      return "BASE PROMPT";
    },
    systemPromptOptions: { appendSystemPrompt },
  };
}

test("plan mode appends the plan prompt and keeps only read tools", async () => {
  const { handlers, activeTools } = setup("plan");
  const event = beforeAgentStartEvent();
  const result = await handlers.get("before_agent_start")?.(event);

  assert.equal(result, undefined, "no forced prompt: pi keeps rendering its own sections");
  // 语言约束固定在最前，计划模式在其后追加。
  assert.equal(
    event.systemPromptOptions.appendSystemPrompt,
    `${RESPONSE_LANGUAGE_PROMPT}

${PLAN_MODE_SYSTEM_PROMPT}`,
  );
  // 只读工具 + memory 多态工具（plan 模式只放行 recall 动作）。
  assert.deepEqual(activeTools[0].slice().sort(), ["find", "grep", "ls", "memory", "read", "tool_history_get"]);
});

test("plan mode appends after an existing append prompt", async () => {
  const { handlers } = setup("plan");
  const event = beforeAgentStartEvent("CUSTOM");
  await handlers.get("before_agent_start")?.(event);
  assert.equal(
    event.systemPromptOptions.appendSystemPrompt,
    `CUSTOM\n\n${RESPONSE_LANGUAGE_PROMPT}\n\n${PLAN_MODE_SYSTEM_PROMPT}`,
  );
});

test("full mode keeps the custom prompt and only adds the language rule", async () => {
  const { handlers } = setup("full");
  const event = beforeAgentStartEvent("CUSTOM");
  const result = await handlers.get("before_agent_start")?.(event);
  assert.equal(result, undefined);
  assert.equal(
    event.systemPromptOptions.appendSystemPrompt,
    `CUSTOM

${RESPONSE_LANGUAGE_PROMPT}`,
    "语言约束与模式无关，必须始终存在",
  );
  assert.match(RESPONSE_LANGUAGE_PROMPT, /进度说明/);
});

type RegisteredTool = { name: string; description?: string; parameters?: unknown; exposure?: string };

function setupPrefix(options: {
  mode?: "plan" | "ask" | "full";
  cwd?: string;
  registered?: RegisteredTool[];
  active?: string[];
} = {}) {
  const handlers = new Map<string, Handler>();
  const activeTools: string[][] = [];
  /** 模拟 SDK：tool_search 激活后 `getActiveTools()` 会包含它。 */
  const activeState: string[] = (options.active ?? []).slice();
  const registered = options.registered ?? [];
  const pi = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    setActiveTools: (names: string[]) => {
      activeTools.push(names);
      activeState.length = 0;
      activeState.push(...names);
    },
    getAllTools: () => registered,
    getActiveTools: () => activeState,
    registerTool: () => {},
  } as unknown as ExtensionAPI;
  const modeRef = {
    current: options.mode ?? "full",
    toolPreset: "default" as const,
    ...(options.cwd ? { getCwd: () => options.cwd } : {}),
  };
  createDesktopApprovalFactory(modeRef)(pi);
  return {
    handlers,
    activeTools,
    modeRef,
    /** 模拟 tool_search：把名字加进 active 集合（不触发取消声明）。 */
    activate: (name: string) => {
      if (!activeState.includes(name)) activeState.push(name);
    },
  };
}

function prefixEvent() {
  return {
    type: "before_agent_start",
    prompt: "hi",
    get systemPrompt() {
      return "BASE PROMPT";
    },
    systemPromptOptions: {
      appendSystemPrompt: "",
      cwd: "D:/Pi/PiForge",
      sections: {} as Record<string, string>,
      selectedTools: [] as string[],
    },
  };
}

async function withEnv<T>(name: string, value: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

test("prefix purity: identical state yields byte-identical tools and prompt", async () => {
  const registered: RegisteredTool[] = [
    { name: "browser", description: "Browser actions" },
    { name: "shell", description: "Shell actions" },
    { name: "fleet", description: "Fleet actions" },
    { name: "orchestrator", description: "Orchestrator actions" },
    { name: "memory", description: "Memory actions" },
    // 旧名字仍然在注册表里（deferred），但绝不能因为注册就重新被声明。
    { name: "browser_read", description: "Read the built-in browser page text" },
    { name: "run_bg", description: "Run a command in the background" },
    { name: "spawn_agent", description: "Delegate to a sub-agent" },
    { name: "herdr_spawn", description: "Spawn a fleet agent" },
    { name: "tool_history_get", description: "Read oversized tool output" },
    { name: "tool_search", description: "Search deferred tools" },
  ];
  const { handlers, activeTools } = setupPrefix({ registered, cwd: "D:\\Pi\\PiForge" });

  const first = prefixEvent();
  await handlers.get("before_agent_start")?.(first);
  const second = prefixEvent();
  await handlers.get("before_agent_start")?.(second);

  assert.deepEqual(activeTools[0], activeTools[1], "同一状态两次请求的工具数组必须完全相等");
  assert.deepEqual(
    first.systemPromptOptions,
    second.systemPromptOptions,
    "同一状态两次请求的提示词输入必须完全相等",
  );
  // 常驻域（browser/shell/fleet）+ 通道工具；按需域（memory/orchestrator）默认不声明。
  assert.deepEqual(activeTools[0], [
    "bash",
    "browser",
    "edit",
    "fleet",
    "read",
    "shell",
    "tool_history_get",
    "tool_search",
    "write",
  ]);
  assert.ok(!activeTools[0].includes("memory"), "memory 是 tool_search 激活的按需域");
  assert.ok(!activeTools[0].includes("orchestrator"), "orchestrator 是 tool_search 激活的按需域");
  for (const legacy of ["browser_read", "run_bg", "spawn_agent", "herdr_spawn"]) {
    assert.ok(!activeTools[0].includes(legacy), `${legacy} 已收进多态工具，不得单独声明`);
  }
  const addendum = (first.systemPromptOptions as { appendSystemPrompt?: string }).appendSystemPrompt ?? "";
  assert.doesNotMatch(addendum, /browser_read: Read the built-in browser page text/);
  assert.equal(
    addendum,
    (second.systemPromptOptions as { appendSystemPrompt?: string }).appendSystemPrompt,
    "存根目录本身也必须是静态文本",
  );
});

test("tool order is ASCII sorted even when the registry order churns", async () => {
  const tools = [
    { name: "mcp__Zeta", exposure: "direct" },
    { name: "mcp__alpha", exposure: "direct" },
    { name: "bash" },
  ];
  const { handlers, activeTools } = setupPrefix({ registered: tools, cwd: "/repo" });
  // 用过扩展工具 → 放开完整集合
  await handlers.get("tool_call")?.({ toolName: "browser_read", input: {} });
  await handlers.get("before_agent_start")?.(prefixEvent());
  const order = activeTools[0];
  assert.deepEqual(order, [...order].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  assert.ok(order.indexOf("mcp__Zeta") < order.indexOf("mcp__alpha"), "ASCII 序：大写在前");

  // 注册顺序反过来，集合不变 → 锁存后必须一模一样
  const churned = setupPrefix({
    registered: [tools[2], tools[1], tools[0]],
    cwd: "/repo",
  });
  await churned.handlers.get("tool_call")?.({ toolName: "browser_read", input: {} });
  await churned.handlers.get("before_agent_start")?.(prefixEvent());
  assert.deepEqual(churned.activeTools[0], order);
});

test("cwd stays in the system prompt by default (per-session constant)", async () => {
  const { handlers } = setupPrefix({ cwd: "D:\\Pi\\PiForge" });
  const event = prefixEvent();
  const result = await handlers.get("before_agent_start")?.(event);
  assert.equal(event.systemPromptOptions.sections.cwd, undefined, "不应改写 SDK 的 cwd 段");
  assert.equal(result, undefined, "默认不注入额外的用户消息块");
});

test("PIFORGE_PREFIX_STRIP_CWD=1 moves cwd out of the prompt into the user message", async () => {
  await withEnv("PIFORGE_PREFIX_STRIP_CWD", "1", async () => {
    const { handlers } = setupPrefix({ cwd: "D:\\Pi\\PiForge" });
    const event = prefixEvent();
    const result = (await handlers.get("before_agent_start")?.(event)) as {
      message?: { customType?: string; content?: unknown; display?: boolean };
    };
    assert.equal(event.systemPromptOptions.sections.cwd, STATIC_CWD_SECTION);
    assert.ok(result?.message, "真实 cwd 必须随用户消息下发");
    assert.equal(result.message.display, false);
    assert.equal(result.message.content, "<context>cwd: D:/Pi/PiForge</context>");
  });
});

test("a tool activated on the SDK side is not dropped by the loadout latch", async () => {
  /** 6 个直接暴露的 MCP 工具 → 扩展工具数 > 5 → 走存根模式。 */
  const mcpTools: RegisteredTool[] = ["a", "b", "c", "d", "e", "f"].map((suffix) => ({
    name: `mcp__${suffix}`,
    exposure: "direct",
    description: `Tool ${suffix}`,
  }));
  const registered: RegisteredTool[] = [...mcpTools, { name: "tool_search", description: "Search" }];
  const state: { active: string[] } = { active: [] };
  const handlers = new Map<string, Handler>();
  const seen: string[][] = [];
  const pi = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    setActiveTools: (names: string[]) => seen.push(names),
    getAllTools: () => registered,
    getActiveTools: () => state.active,
    registerTool: () => {},
  } as unknown as ExtensionAPI;
  createDesktopApprovalFactory({ current: "full", toolPreset: "default" })(pi);

  await handlers.get("before_agent_start")?.(prefixEvent());
  assert.deepEqual(seen[0], ["bash", "edit", "read", "tool_search", "write"]);
  assert.ok(!seen[0].includes("mcp__a"), "存根模式下不声明完整 schema");

  // 模型点名要 mcp__a：SDK 把它激活，且它真的被调用过。
  await handlers.get("tool_call")?.({ toolName: "mcp__a", input: {} });
  state.active = ["bash", "edit", "mcp__a", "read", "write"];
  await handlers.get("before_agent_start")?.(prefixEvent());
  assert.ok(seen[1].includes("mcp__a"), "被点名的工具必须完整注入");
  assert.ok(!seen[1].includes("mcp__b"), "其余工具仍然保持存根");

  // 状态没再变：第三次请求必须与第二次字节级一致（锁存生效）。
  await handlers.get("before_agent_start")?.(prefixEvent());
  assert.deepEqual(seen[2], seen[1]);
});

test("desktop_use_tool loads a stubbed tool on the next turn", async () => {
  const registered: RegisteredTool[] = [
    { name: "browser_read", description: "Read the browser" },
    { name: "run_bg", description: "Run in background" },
    { name: "spawn_agent", description: "Delegate" },
    { name: "tool_history_get", description: "Read oversized tool output" },
    { name: "tool_search", description: "Search" },
  ];
  const state: { active: string[] } = { active: [] };
  const registeredTools: Array<{
    name: string;
    execute: (id: string, params: Record<string, unknown>) => Promise<{ content: unknown[] }>;
  }> = [];
  const handlers = new Map<string, Handler>();
  const seen: string[][] = [];
  const pi = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    setActiveTools: (names: string[]) => {
      state.active = [...names];
      seen.push(names);
    },
    getAllTools: () => registered,
    getActiveTools: () => state.active,
    registerTool: (definition: { name: string; execute: never }) => {
      registeredTools.push(definition);
      registered.push({ name: definition.name, description: "Load a stubbed tool" });
    },
  } as unknown as ExtensionAPI;
  createDesktopApprovalFactory({ current: "full", toolPreset: "default" })(pi);

  await handlers.get("before_agent_start")?.(prefixEvent());
  assert.ok(!seen[0].includes("browser_read"), "默认只给存根");
  assert.ok(seen[0].includes("desktop_use_tool"), "点名通道必须声明");

  const useTool = registeredTools.find((tool) => tool.name === "desktop_use_tool");
  assert.ok(useTool, "desktop_use_tool 必须注册");
  const result = (await useTool!.execute("call-1", { name: "browser_read" })) as {
    content: Array<{ text?: string }>;
  };
  assert.match(result.content[0]?.text ?? "", /Loaded browser_read/);

  await handlers.get("before_agent_start")?.(prefixEvent());
  assert.ok(seen[1].includes("browser_read"), "点名后必须完整注入");
  assert.ok(!seen[1].includes("run_bg"), "没点名的仍然保持存根");

  // 未知工具名不能污染装载
  const bad = (await useTool!.execute("call-2", { name: "nope" })) as {
    content: Array<{ text?: string }>;
  };
  assert.match(bad.content[0]?.text ?? "", /Unknown tool/);
});

test("plan mode also reports the prefix diff only when it changes", async () => {
  await withEnv("PIFORGE_DEBUG_PREFIX", "1", async () => {
    const { handlers } = setupPrefix({ mode: "plan", cwd: "/repo" });
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      await handlers.get("before_agent_start")?.(prefixEvent());
      await handlers.get("before_agent_start")?.(prefixEvent());
    } finally {
      console.log = original;
    }
    assert.equal(lines.length, 1, "第二次前缀未变，不应重复打印");
    assert.match(lines[0], /首次建立前缀/);
  });
});

test("activated on-demand domains (memory/orchestrator) join the declaration and stay latched", async () => {
  const registered: RegisteredTool[] = [
    { name: "browser", description: "Browser actions" },
    { name: "shell", description: "Shell actions" },
    { name: "fleet", description: "Fleet actions" },
    { name: "memory", description: "Memory actions" },
    { name: "orchestrator", description: "Orchestrator actions" },
    { name: "tool_search", description: "Search deferred tools" },
  ];
  const { handlers, activeTools, activate } = setupPrefix({ registered, cwd: "/repo" });

  await handlers.get("before_agent_start")?.(prefixEvent());
  assert.ok(!activeTools[0].includes("memory"), "默认不声明按需域");

  // tool_search 激活 memory 之后（SDK 调 setActiveTools 把它写进 active），下一轮必须声明它。
  activate("memory");
  await handlers.get("before_agent_start")?.(prefixEvent());
  assert.ok(activeTools[1].includes("memory"), "激活后必须进入声明集合");

  // 之后保持声明（前缀只变这一次）。
  await handlers.get("before_agent_start")?.(prefixEvent());
  assert.ok(activeTools[2].includes("memory"));
  assert.deepEqual(activeTools[1], activeTools[2], "激活后前缀字节稳定");
});
