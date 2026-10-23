/**
 * 多态工具（domain tool）路由表 —— 纯数据，Host 与 Next 共用。
 *
 * 背景：扩展工具每个都带一份完整的 JSON Schema 骨架（name/label/description/
 * parameters/required），20 个工具光是骨架和公共字段就吃掉 ~1.6k tokens，而它们
 * **每一轮请求都要重新声明**。这里按域把它们收成 5 个多态工具：一个 `action`
 * 参数分派，参数约束与动作语义**原样保留**（由 agent-host/domain-tools.ts 从原
 * 定义自动合成，不手抄、不压缩）。
 *
 * 这份表同时是 UI 的翻译层：`expandDomainToolCall()` 把 `shell{action:"run"}` 还原成
 * `run_bg{...}`，于是 Transcript / 审批 / 运行指示器 / i18n 全部沿用旧工具名，
 * 用户可感知的渲染与权限行为不变。
 */

export type DomainToolName = "browser" | "shell" | "fleet" | "orchestrator" | "memory";

export const DOMAIN_TOOL_NAMES: readonly DomainToolName[] = [
  "browser",
  "shell",
  "fleet",
  "orchestrator",
  "memory",
];

/**
 * 常驻声明的域：每轮都在前缀里，模型随时可用。
 */
export const ALWAYS_DECLARED_DOMAINS: readonly DomainToolName[] = ["browser", "shell", "fleet"];

/**
 * 可选的「按需域」候选：memory / orchestrator。
 *
 * **默认关闭**（第 5 步实测结论）：这两个域收起来只省 617 tok/轮，但第一次使用时
 * 要付 ①一次 tool_search 往返 ②一次前缀重写（缓存全部作废）。实测 30 轮真实会话：
 * 激活那两轮多出 ~21k 未缓存 token，而 29 轮稳态只省回 ~18k（且缓存读单价通常只有
 * 输入价的 10%，换算成钱更不划算）。所以默认恢复成常驻声明；
 * `PIFORGE_ON_DEMAND_DOMAINS=1` 可显式打开（长会话 >100 轮或不支持前缀缓存的模型）。
 */
export const ON_DEMAND_DOMAINS: readonly DomainToolName[] = ["memory", "orchestrator"];

/**
 * 默认对**中频域**开启按需：`shell`。
 *
 * 第 8 步 A/B 实测（30 轮 deepseek，shell 真实调用 4 次）：
 *   前缀 6 961 → 6 220（每轮省 741 tok），激活只花 4 600 tok，
 *   回本 ≈ 6.2 轮，30 轮净收益 ≈ +13 000 tok，命中率 97.9%（A 98.0%）。
 * memory / orchestrator 仍是负收益（第 5 步实测），**不**默认开启。
 */
export const DEFAULT_ON_DEMAND_DOMAINS: readonly DomainToolName[] = ["shell"];

export type OnDemandSource = "env" | "settings" | "default";

export interface ResolvedOnDemand {
  domains: DomainToolName[];
  source: OnDemandSource;
}

/**
 * 开关优先级：**环境变量 > 设置项 > 默认值（shell）**。
 *
 * 语义（第 9 步定稿，README / 设置页 / CHANGELOG 三处一致）：
 *   - `0`            → 全部常驻（A 组）
 *   - `1`            → 兼容别名：memory + orchestrator 按需（第 3–5 步的历史行为）
 *   - `a,b`          → 显式列表，例如 `shell` / `browser,shell`
 *   - 未设置         → 设置项 `onDemandDomains`；设置项也没有 → 默认 `shell`
 */
export function resolveOnDemandDomains(options: {
  env?: Record<string, string | undefined>;
  settings?: readonly string[] | null;
} = {}): ResolvedOnDemand {
  const envValue = options.env?.PIFORGE_ON_DEMAND_DOMAINS?.trim();
  if (envValue) {
    if (envValue === "0") return { domains: [], source: "env" };
    if (envValue === "1") return { domains: [...ON_DEMAND_DOMAINS], source: "env" };
    const wanted = new Set(envValue.split(",").map((entry) => entry.trim()).filter(Boolean));
    return { domains: DOMAIN_TOOL_NAMES.filter((domain) => wanted.has(domain)), source: "env" };
  }
  if (Array.isArray(options.settings)) {
    const wanted = new Set(options.settings);
    return { domains: DOMAIN_TOOL_NAMES.filter((domain) => wanted.has(domain)), source: "settings" };
  }
  return { domains: [...DEFAULT_ON_DEMAND_DOMAINS], source: "default" };
}

/**
 * 运行期覆盖：Host 在会话创建时用「设置项 + 环境变量」解析一次，之后所有声明/合成
 * 都读这个值（模块级，因为 desktop-settings 是全局的）。
 */
let runtimeOnDemand: DomainToolName[] | null = null;

export function setRuntimeOnDemandDomains(domains: readonly string[] | null): void {
  if (domains === null) {
    runtimeOnDemand = null;
    return;
  }
  const wanted = new Set(domains);
  runtimeOnDemand = DOMAIN_TOOL_NAMES.filter((domain) => wanted.has(domain));
}

export function getRuntimeOnDemandDomains(): readonly DomainToolName[] | null {
  return runtimeOnDemand;
}

export function enabledOnDemandDomains(
  env: Record<string, string | undefined> = process.env
): readonly DomainToolName[] {
  if (runtimeOnDemand) return runtimeOnDemand;
  return resolveOnDemandDomains({ env }).domains;
}

export function isOnDemandDomain(
  name: string,
  env: Record<string, string | undefined> = process.env
): name is DomainToolName {
  return (enabledOnDemandDomains(env) as readonly string[]).includes(name);
}

export interface DomainRoute {
  /** 暴露给模型的 action 值。 */
  action: string;
  /** 真正执行它的旧工具名（保持 `exposure: "deferred"`，只能被工具内部调用）。 */
  tool: string;
  /**
   * 旧工具自己也有 `action` 参数时（browser_read 的 read/screenshot），
   * 这里给出要注入的旧 action 值。
   */
  legacyAction?: string;
  /** 只读动作：plan 模式允许。 */
  planAllowed?: boolean;
}

export const DOMAIN_ROUTES: Record<DomainToolName, readonly DomainRoute[]> = {
  browser: [
    { action: "open", tool: "browser_interact", planAllowed: false },
    { action: "back", tool: "browser_interact", planAllowed: false },
    { action: "forward", tool: "browser_interact", planAllowed: false },
    { action: "reload", tool: "browser_interact", planAllowed: false },
    { action: "read", tool: "browser_read", legacyAction: "read", planAllowed: true },
    { action: "screenshot", tool: "browser_read", legacyAction: "screenshot", planAllowed: true },
  ],
  shell: [
    { action: "run", tool: "run_bg", planAllowed: false },
    { action: "read", tool: "process_read", planAllowed: true },
    { action: "wait", tool: "process_wait", planAllowed: true },
    { action: "exec", tool: "powershell", planAllowed: false },
  ],
  fleet: [
    { action: "spawn", tool: "spawn_agent", planAllowed: false },
    { action: "launch", tool: "herdr_spawn", planAllowed: false },
    { action: "status", tool: "herdr_status", planAllowed: true },
    { action: "message", tool: "herdr_message", planAllowed: false },
    { action: "stop", tool: "herdr_stop", planAllowed: false },
  ],
  orchestrator: [
    { action: "spawn", tool: "orchestrator_spawn", planAllowed: false },
    { action: "status", tool: "orchestrator_status", planAllowed: true },
  ],
  memory: [
    { action: "recall", tool: "memory_recall", planAllowed: true },
    { action: "save", tool: "memory_save", planAllowed: false },
    { action: "forget", tool: "memory_forget", planAllowed: false },
  ],
};

/**
 * 被多态工具**完全取代**的旧工具：仍镜像注册成 deferred（老会话、嵌套调用、
 * 直接 `/tools` 调用都还能用），但不再声明、不再进存根目录。
 * `web_preview` 与 `browser_read`/`browser_interact` 走的是同一个 Main-owned
 * 浏览器桥（right-panel WebContentsView），三个名字合并成一个 `browser`。
 */
export const SUPERSEDED_LEGACY_TOOLS: readonly string[] = ["web_preview"];

/** 全部被收进多态工具的旧工具名（它们不再直接声明给模型）。 */
export const DOMAIN_LEGACY_TOOLS: ReadonlySet<string> = new Set([
  ...Object.values(DOMAIN_ROUTES).flatMap((routes) => routes.map((route) => route.tool)),
  ...SUPERSEDED_LEGACY_TOOLS,
]);

export function isDomainToolName(name: string): name is DomainToolName {
  return (DOMAIN_TOOL_NAMES as readonly string[]).includes(name);
}

export function routeForAction(
  domain: DomainToolName,
  action: unknown
): DomainRoute | undefined {
  if (typeof action !== "string") return undefined;
  return DOMAIN_ROUTES[domain].find((route) => route.action === action);
}

export function isLegacyDomainTool(name: string): boolean {
  return DOMAIN_LEGACY_TOOLS.has(name);
}

/** plan 模式允许的多态工具动作（与旧 PLAN_TOOLS 的只读语义一一对应）。 */
export function planAllowedDomainActions(domain: DomainToolName): string[] {
  return DOMAIN_ROUTES[domain].filter((route) => route.planAllowed).map((route) => route.action);
}

export function isPlanAllowedDomainCall(name: string, input: unknown): boolean {
  if (!isDomainToolName(name)) return false;
  const action =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>).action
      : undefined;
  return routeForAction(name, action)?.planAllowed === true;
}

/**
 * 把多态工具调用还原成旧工具调用。无法识别（未知 action）时返回 null，
 * 由调用方保持原样 —— 错误的 action 会被执行层报成参数错误，而不是静默丢弃。
 */
export function expandDomainToolCall(
  name: string,
  input: Record<string, unknown>
): { toolName: string; input: Record<string, unknown> } | null {
  if (!isDomainToolName(name)) return null;
  const route = routeForAction(name, input.action);
  if (!route) return null;
  const { action, ...rest } = input;
  void action;
  return {
    toolName: route.tool,
    input: route.legacyAction ? { ...rest, action: route.legacyAction } : rest,
  };
}

/**
 * plan 模式下允许的**只读旧工具**：多态工具的只读动作会分派回这些名字，
 * 嵌套调用的 tool_call 钩子必须放行，否则 plan 模式里 `memory{recall}` 会被拦。
 */
export const PLAN_READONLY_LEGACY_TOOLS: ReadonlySet<string> = new Set([
  "memory_recall",
  "process_read",
  "process_wait",
  "browser_read",
]);

/**
 * 反向：旧工具名 → 多态工具 + action（子 Agent 授权、设置页展示、迁移用）。
 *
 * 旧工具自己有多个子动作时（`browser_read` = read/screenshot）必须传 `legacyAction`
 * 才能唯一确定动作；省略时只保证域正确（子 Agent 授权只需要域）。
 */
export function collapseToolName(
  legacyTool: string,
  legacyAction?: string
): { tool: DomainToolName; action: string } | null {
  const wanted = legacyAction ?? null;
  for (const domain of DOMAIN_TOOL_NAMES) {
    const route = DOMAIN_ROUTES[domain].find(
      (candidate) =>
        candidate.tool === legacyTool &&
        (wanted === null ? true : (candidate.legacyAction ?? candidate.action) === wanted)
    );
    if (route) return { tool: domain, action: route.action };
  }
  return null;
}
