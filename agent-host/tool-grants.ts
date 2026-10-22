/**
 * 子 Agent 的工具授权（护智 · 第一部分）。
 *
 * 破过的坑：子 Agent 固定只拿 `read/grep/find/ls`，父 Agent 让它跑测试、看 diff、
 * 改一行配置时它只能空转或者瞎编 —— 这不是省钱，是把推理质量按件贱卖。
 *
 * 规则：
 *   1. **默认继承**父 Agent 当前的 `activeTools`；`CHILD_CORE_TOOLS` 只要运行时
 *      提供就强制保留（bash / read / write / edit），不做"只读洁癖"；
 *   2. 父 Agent 显式传 `tools: [...]` 时**按需放开**（取并集，只会更宽不会更窄）；
 *   3. 递归 / UI 副作用工具永不下放（spawn_agent、herdr_*、orchestrator_*、
 *      受管进程、浏览器…），否则子 Agent 会再拉子 Agent，成本和状态一起失控；
 *   4. 请求了运行时根本没有的工具 → 立刻抛 `PERMISSION_MISSING`，第一轮就把
 *      权限缺失讲清楚，不允许子 Agent 空转到熔断。
 *
 * 与「存根机制」的关系（架构冲突核对结论）：
 *   存根（tool-stubs）只瘦身**声明层**的 schema 目录，`pi.getAllTools()` 里的
 *   注册表永远完整。所以授权只读全量注册表、绝不读存根目录 —— 存根一开不会
 *   影响提权；反过来，子 Agent 的工具集也不会回写给父 Agent 的声明，父 Agent
 *   的前缀缓存（静态 schema + A-Z 排序）保持字节级稳定。
 */
import { canonicalToolOrder } from "./prompt-prefix.ts";

/** 子 Agent 必须有（运行时存在的话）的核心工具：「瞎子」问题的正面解法。 */
export const CHILD_CORE_TOOLS = ["bash", "read", "write", "edit"] as const;

/** 递归 / UI 副作用工具：无论父 Agent 有没有，都不下放。 */
const DENIED_TOOLS = new Set([
  "spawn_agent",
  "herdr_spawn",
  "herdr_message",
  "herdr_status",
  "orchestrator_spawn",
  "orchestrator_status",
  "run_bg",
  "process_read",
  "process_wait",
  "browser_interact",
  "browser_read",
  "web_preview",
  "generate_image",
]);

const DENIED_PREFIXES = ["herdr_", "orchestrator_", "desktop_"];

export class ToolGrantError extends Error {
  readonly code = "PERMISSION_MISSING";

  constructor(message: string) {
    super(message);
    this.name = "ToolGrantError";
  }
}

export function isChildToolDenied(name: string): boolean {
  if (DENIED_TOOLS.has(name)) return true;
  return DENIED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export interface ResolveChildToolsInput {
  /** 父 Agent 显式要求的工具（`spawn_agent({ tools: [...] })`）。 */
  requested?: readonly string[] | null;
  /** 父 Agent 当前 activeTools（默认继承）。 */
  parentActive?: readonly string[] | null;
  /** 运行时**全量**注册表里的工具名（不是存根目录）。 */
  available: readonly string[];
  /** 报错文案里怎么称呼这个子 Agent。 */
  name?: string;
}

export interface ResolvedChildTools {
  /** 最终下放的工具（A-Z 排序去重 → 子 Agent 自己的前缀缓存也稳定）。 */
  tools: string[];
  /** 被拒绝的递归 / UI 工具（写进子 Agent 的自述里，避免它以为是自己瞎）。 */
  denied: string[];
}

/**
 * 计算子 Agent 的工具集。权限不足时**同步抛出** `ToolGrantError`，
 * 由 spawn 层直接作为工具错误返回给父 Agent（第一轮就可见）。
 */
export function resolveChildTools(input: ResolveChildToolsInput): ResolvedChildTools {
  const available = canonicalToolOrder(input.available);
  const availableSet = new Set(available);
  const requested = canonicalToolOrder(input.requested ?? []);
  const parentActive = canonicalToolOrder(input.parentActive ?? []);

  const usable = (name: string) => availableSet.has(name) && !isChildToolDenied(name);

  const missing = requested.filter((name) => !availableSet.has(name) && !isChildToolDenied(name));
  if (missing.length > 0) {
    throw new ToolGrantError(
      `权限缺失（PERMISSION_MISSING）：子 Agent「${input.name ?? "sub-agent"}」被要求使用 ` +
        `[${missing.join(", ")}]，但当前运行时没有这些工具。` +
        `运行时可用：${available.length > 0 ? available.join(", ") : "（空）"}。` +
        `请改用具名工具，或先在主 Agent 里启用它再派生。`,
    );
  }

  const inherited = parentActive.filter(usable);
  const granted = requested.filter(usable);
  const core = CHILD_CORE_TOOLS.filter(usable);
  const tools = canonicalToolOrder([...inherited, ...granted, ...core]);

  if (tools.length === 0) {
    throw new ToolGrantError(
      "权限缺失（PERMISSION_MISSING）：没有任何工具可以下放给子 Agent，" +
        "它连读文件都做不到。请给 spawn 传入 tools，或检查运行时工具注册。",
    );
  }

  const denied = canonicalToolOrder(
    [...requested, ...parentActive].filter((name) => isChildToolDenied(name)),
  );
  return { tools, denied };
}

/** 子 Agent 自述用的工具清单（静态拼接，长度可控）。 */
export function childToolSummary(tools: readonly string[], denied: readonly string[] = []): string {
  const lines = [
    `Tools granted to you for this task: ${tools.join(", ")}.`,
    "Those are real, executable tools — use them instead of guessing. " +
      "If a tool you need is missing, say exactly which one and stop; never fabricate output.",
  ];
  if (denied.length > 0) {
    lines.push(
      `Deliberately not granted (recursion / UI side effects): ${denied.join(", ")}.`,
    );
  }
  return lines.join("\n");
}
