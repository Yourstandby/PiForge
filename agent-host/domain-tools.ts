/**
 * 多态工具的**合成器**（第 2 步：静态前缀瘦身）。
 *
 * 问题：20 个扩展工具每个都带一整份 JSON Schema（骨架 + 公共字段），
 * 每轮请求都要重发；实测 tools 3 745 tok，其中扩展工具 3 035。
 *
 * 做法：**不动任何实现**。
 *   1. 每个扩展把自己的工具定义交给 `registerDomainAction()`：镜像注册成
 *      `exposure: "deferred"`（不再声明给模型，但仍可被工具内部调用），并把原
 *      定义记进本模块的注册表；
 *   2. 域扩展最后注册 5 个多态工具（browser / shell / fleet / orchestrator /
 *      memory），schema 由注册表**自动合成**：每个 action 的完整描述、必填字段、
 *      可选字段全部从原定义里取，不手抄、不压缩；重复的公共字段只留一份；
 *   3. 多态工具的 execute 用 `ctx.executeTool()` 分派到原工具 —— 走同一条
 *      校验 / 审批 / 事件管线，权限检查与 UI 渲染沿用旧工具名。
 *
 * 省的是重复的骨架与公共字段，不是动作语义。
 */
import { Type, type TSchema } from "typebox";
import type { ExtensionAPI, ToolDefinition } from "./sdk-adapter.ts";
import {
  DOMAIN_ROUTES,
  DOMAIN_TOOL_NAMES,
  isOnDemandDomain,
  planAllowedDomainActions,
  routeForAction,
  type DomainRoute,
  type DomainToolName,
} from "../lib/domain-tools.ts";

type AnyToolDefinition = ToolDefinition<TSchema, unknown, unknown>;

interface RegisteredAction {
  domain: DomainToolName;
  route: DomainRoute;
  definition: AnyToolDefinition;
}

const registry = new Map<string, RegisteredAction>();

function registryKey(domain: DomainToolName, action: string, tool: string): string {
  return `${domain}:${action}:${tool}`;
}

/** 测试与资源重载用：清空注册表（重载后各扩展会重新登记）。 */
export function resetDomainRegistry(): void {
  registry.clear();
}

/**
 * 登记一个动作并镜像注册旧的单工具定义。
 *
 * 旧定义以 `exposure: "deferred"` 注册：模型看不到它的 schema，但
 * `ctx.executeTool()` 仍可调用（同一条 tool_call 审批链）。
 */
export function registerDomainAction<TParams extends TSchema, TDetails, TState>(
  pi: ExtensionAPI,
  domain: DomainToolName,
  action: string,
  definition: ToolDefinition<TParams, TDetails, TState>
): void {
  const route = routeForAction(domain, action);
  if (!route) {
    throw new Error(`registerDomainAction: no route for ${domain}.${action}`);
  }
  if (route.tool !== definition.name) {
    throw new Error(
      `registerDomainAction: ${domain}.${action} routes to ${route.tool}, got ${definition.name}`
    );
  }
  registry.set(registryKey(domain, action, definition.name), {
    domain,
    route,
    definition: definition as unknown as AnyToolDefinition,
  });
  pi.registerTool({
    ...definition,
    // 只保留可调用性：不再声明给模型，也不参与 active 工具集。
    exposure: "deferred",
    defaultActive: false,
  });
}

/** 镜像注册一个被多态工具取代的旧工具：可调用，但不声明、不进目录。 */
export function registerDeferredTool<TParams extends TSchema, TDetails, TState>(
  pi: ExtensionAPI,
  definition: ToolDefinition<TParams, TDetails, TState>
): void {
  pi.registerTool({
    ...definition,
    exposure: "deferred",
    defaultActive: false,
  });
}

function propertiesOf(definition: AnyToolDefinition): Record<string, unknown> {
  const parameters = definition.parameters as unknown as {
    properties?: Record<string, unknown>;
  };
  return parameters?.properties ?? {};
}

function requiredOf(definition: AnyToolDefinition): string[] {
  const parameters = definition.parameters as unknown as { required?: unknown };
  return Array.isArray(parameters?.required)
    ? parameters.required.filter((name): name is string => typeof name === "string")
    : [];
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((key) => `${key}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function descriptionOf(schema: unknown): string | undefined {
  return schema && typeof schema === "object" && typeof (schema as { description?: unknown }).description === "string"
    ? ((schema as { description: string }).description)
    : undefined;
}

/** 同名参数的描述冲突时合并（例如 run 与 exec 都有自己的 `command`）。 */
function mergeProperty(action: string, existing: unknown, incoming: unknown): unknown {
  const withoutDescription = (schema: unknown) => {
    if (!schema || typeof schema !== "object") return schema;
    const { description, ...rest } = schema as Record<string, unknown>;
    void description;
    return rest;
  };
  if (canonical(withoutDescription(existing)) !== canonical(withoutDescription(incoming))) {
    throw new Error(
      `domain tool: conflicting parameter schema for "${action}" — the same property name cannot carry different constraints`
    );
  }
  const left = descriptionOf(existing);
  const right = descriptionOf(incoming);
  if (!right || (left && left.includes(right))) return existing;
  if (!left) return { ...(existing as Record<string, unknown>), description: right };
  if (right.includes(left)) return { ...(existing as Record<string, unknown>), description: right };
  // 同一字段在多个动作里各写一遍说明时**只留信息量最大的一份**：
  // 两张说明讲的是同一个参数，拼起来只是把同一件事说两遍（付两遍钱）。
  const merged = right.length > left.length ? right : left;
  return { ...(existing as Record<string, unknown>), description: merged };
}

/**
 * 多态工具的**人写摘要**（每个动作一段，事实全保留、只去掉跨工具的重复叙述）。
 *
 * 为什么不直接用原 description：原文本每个工具都自带一遍"继承 active tools"、
 * "子 Agent 看不到本对话"、"不是沙箱"等公共背景，合并后这些句子会重复 2–5 次。
 * 重复的部分提到域级一句话，动作行只留该动作独有的语义 —— 语义一条不少，
 * 成本只付一次。schema / 参数 / 必填项仍然从原定义自动合成，不手抄。
 */
const DOMAIN_PREAMBLE: Record<DomainToolName, string> = {
  browser:
    "Built-in browser (Main-owned view). Verify UI instead of guessing: open the localhost URL, wait for load, then read or screenshot. If `url` is given the tool opens it first.",
  shell:
    "Shell + managed background processes. Managed processes keep running after the tool returns; the user can stop/force-stop/restart them in the Processes tab. Not a sandbox: the host tracks and cleans up the process tree it started.",
  fleet:
    "Sub-agents. Both spawn kinds inherit your active tools plus bash/read/write/edit; recursion/UI tools are never granted; `tools` adds more. Agents never see this conversation, so taskPrompt must be self-contained (paths, goals, required report). Their report comes back as this tool's result.",
  orchestrator:
    "Worktree workers: one self-contained task per isolated OS worker process with its own Git worktree.",
  memory: "Project long-term memory. Recall is read-only and allowed in plan mode.",
};

const ACTION_TEXT: Record<DomainToolName, Record<string, string>> = {
  browser: {
    open: "Navigate to a URL (http(s); a bare loopback host:port is accepted).",
    back: "Go back in history.",
    forward: "Go forward in history.",
    reload: "Reload the current page.",
    read: "Return the rendered page text (maxChars, default 12000; raise it for long pages).",
    screenshot: "PNG of the visible viewport.",
  },
  shell: {
    run: "Run a command with cmd.exe or PowerShell (`shell`) in the background, as a managed process (`name` labels it).",
    read: "Tail a managed process's logs from an absolute cursor; omit cursor on the first read and pass the returned nextCursor afterwards. Read-only.",
    wait: "Block until the process is ready (default) or has exited. Read-only; never stops it.",
    exec: "Run a PowerShell command synchronously (pwsh 7 first, UTF-8, -NoProfile -NonInteractive).",
  },
  fleet: {
    spawn: "One-shot sub-agent with its own context; spawn several in one turn for independent areas; don't use it for work you can finish in one or two tool calls.",
    launch: "Persistent in-memory fleet agent that exits as soon as its task finishes (no background idling); status/message work while it runs; pass timeoutMs when the task can hang (it is killed on timeout). Results are checked for test evidence and marked verified:false when none exists.",
    status: "Read one agent's status/output, or list the whole fleet (read-only).",
    message: "Send a follow-up to a running agent and wait for its reply (bounded by timeoutMs).",
    stop: "Stop (sleep) one agent or the whole fleet (all=true); frees a fleet slot and the config can be woken again.",
  },
  orchestrator: {
    spawn: "Runs in its own worktree; the report and changed files return in the status panel. Best for independent parallel work that needs no parent context: standalone brief per worker, at most four at once.",
    status: "List workers with their worktrees, status, changed files and reports (optionally one id). Use after spawning.",
  },
  memory: {
    recall: "Search stored memories and observations by query.",
    save: "Store a durable memory: preference, architecture note, bug, fact, workflow or pattern.",
    forget: "Delete memories by id.",
  },
};

function shortParamList(required: string[], optional: string[]): string {
  const parts = [
    required.length > 0 ? `requires ${required.join(", ")}` : "",
    optional.length > 0 ? `opt ${optional.join(", ")}` : "",
  ].filter(Boolean);
  return parts.length > 0 ? ` (${parts.join("; ")})` : "";
}

function actionCatalogue(domain: DomainToolName, actions: RegisteredAction[]): string {
  const lines = actions.map(({ route, definition }) => {
    const required = requiredOf(definition).filter((name) => name !== "action");
    const optional = Object.keys(propertiesOf(definition)).filter(
      (name) => name !== "action" && !required.includes(name)
    );
    const text = ACTION_TEXT[domain][route.action] ?? definition.description.trim();
    return `- ${route.action}${shortParamList(required, optional)}: ${text}`;
  });
  return [DOMAIN_PREAMBLE[domain], ...lines].join("\n");
}

function planNote(domain: DomainToolName): string {
  const allowed = planAllowedDomainActions(domain);
  return allowed.length > 0 ? `
Plan mode: only ${allowed.join(", ")}.` : "";
}

const DOMAIN_LABELS: Record<DomainToolName, { label: string; snippet: string }> = {
  browser: {
    label: "Browser",
    snippet: "Built-in browser: open/back/forward/reload/read/screenshot",
  },
  shell: {
    label: "Shell",
    snippet: "PowerShell + managed background processes (run/read/wait/exec)",
  },
  fleet: {
    label: "Fleet",
    snippet: "Sub-agents: spawn/launch/status/message/stop",
  },
  orchestrator: {
    label: "Orchestrator",
    snippet: "Worktree workers: spawn/status",
  },
  memory: {
    label: "Memory",
    snippet: "Project long-term memory: recall/save/forget",
  },
};

/** 按域合成多态工具定义（在域扩展加载时调用一次）。 */
export function buildDomainToolDefinitions(): ToolDefinition[] {
  const definitions: ToolDefinition[] = [];
  for (const domain of DOMAIN_TOOL_NAMES) {
    const actions = [...registry.values()]
      .filter((entry) => entry.domain === domain)
      .sort((a, b) => {
        const order = DOMAIN_ROUTES[domain].map((route) => route.action);
        return order.indexOf(a.route.action) - order.indexOf(b.route.action);
      });
    if (actions.length === 0) continue;

    const { label, snippet } = DOMAIN_LABELS[domain];
    const catalogue = actionCatalogue(domain, actions);
    const properties: Record<string, unknown> = {
      action: {
        type: "string",
        enum: actions.map(({ route }) => route.action),
        description: "What to do. See the parameter lists in this tool's description.",
      },
    };
    const required: string[] = ["action"];
    for (const { definition } of actions) {
      for (const [name, schema] of Object.entries(propertiesOf(definition))) {
        if (name === "action") continue;
        properties[name] = name in properties ? mergeProperty(name, properties[name], schema) : schema;
      }
    }

    const definition: ToolDefinition = {
      name: domain,
      label,
      // tool_search 只回显 description 的第一行：第一行必须说清「这个域有哪些动作」，
      // 否则模型「搜到了但不知道能干什么」，白跑一次往返。
      description:
        `${label}: ${actions.map(({ route }) => route.action).join(" | ")}.
${catalogue}${planNote(domain)}`,
      promptSnippet: snippet,
      // 每个 action 的必填字段都写在上面那行 catalogue 里；schema 只把 action 设成必填，
      // 逐 action 的必填校验在 execute 里做（同一份 required 表）。
      parameters: Type.Unsafe({
        type: "object",
        properties,
        required,
        additionalProperties: false,
      }),
      // 常驻域：direct + active；按需域：deferred（tool_search 可搜到、可激活），
      // 激活后由 desktop-runtime-tools 在下一轮把它放进声明集合。
      ...(isOnDemandDomain(domain)
        ? { exposure: "deferred" as const, defaultActive: false }
        : { defaultActive: true }),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const input = (params ?? {}) as Record<string, unknown>;
        const action = input.action;
        const entry = actions.find(({ route }) => route.action === action);
        if (!entry) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Unknown action ${JSON.stringify(action)} for tool "${domain}". ` +
                  `Use one of: ${actions.map(({ route }) => route.action).join(", ")}.`,
              },
            ],
            details: { error: "unknown_action", domain, action },
            isError: true,
          };
        }
        const missing = requiredOf(entry.definition).filter(
          (name) => name !== "action" && input[name] === undefined
        );
        if (missing.length > 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `action "${entry.route.action}" requires: ${missing.join(", ")}.`,
              },
            ],
            details: { error: "missing_params", domain, action: entry.route.action, missing },
            isError: true,
          };
        }

        const { action: selectedAction, ...rest } = input;
        void selectedAction;
        const legacyArgs = entry.route.legacyAction
          ? { ...rest, action: entry.route.legacyAction }
          : rest;
        const outcome = await ctx.executeTool(entry.route.tool, legacyArgs, {
          ...(signal ? { signal } : {}),
          ...(onUpdate ? { onUpdate } : {}),
        });
        return {
          content: outcome.result.content,
          details: outcome.result.details ?? {},
          ...(outcome.isError ? { isError: true } : {}),
        };
      },
    };
    definitions.push(definition);
  }
  return definitions;
}

export function registeredDomainActions(domain?: DomainToolName): RegisteredAction[] {
  const entries = [...registry.values()];
  return (domain ? entries.filter((entry) => entry.domain === domain) : entries).sort((a, b) =>
    `${a.domain}.${a.route.action}`.localeCompare(`${b.domain}.${b.route.action}`)
  );
}

/** 该旧工具是否已收进多态工具（决定要不要从存根目录 / 声明集合里剔除）。 */
export function isRegisteredLegacyTool(name: string): boolean {
  return [...registry.values()].some((entry) => entry.route.tool === name);
}
