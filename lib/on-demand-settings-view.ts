/**
 * 按需工具域的「设置页视图」：纯函数，UI 与单测共用。
 *
 * 为什么要单独一层：设置页要显示的是**实际生效的列表**（环境变量 > 设置项 > 默认），
 * 不是配置文件里那行字。把格式化/提示文案抽出来，才能在单测里断言 UI 文案而不渲染 React。
 */
import type { OnDemandSource } from "./domain-tools.ts";

export const ON_DEMAND_DOMAIN_OPTIONS = [
  { value: "shell", label: "shell（PowerShell + 后台进程）" },
  { value: "browser", label: "browser（内置浏览器）" },
  { value: "fleet", label: "fleet（子 Agent / 舰队）" },
  { value: "orchestrator", label: "orchestrator（工作树 worker）" },
  { value: "memory", label: "memory（长期记忆）" },
  { value: "plugin", label: "plugin（插件工具）" },
] as const;

/** 实测按需为负收益的域：可以勾，但要提示。 */
export const ON_DEMAND_NEGATIVE_HINT_DOMAINS = ["memory", "orchestrator"] as const;

const SOURCE_LABEL: Record<OnDemandSource, string> = {
  env: "环境变量 PIFORGE_ON_DEMAND_DOMAINS",
  settings: "设置项 onDemandDomains",
  default: "默认值",
};

export interface OnDemandViewInput {
  domains: readonly string[];
  source: OnDemandSource;
}

/** 一句话说清「实际生效的是哪些域、来自哪里」。 */
export function formatOnDemandSummary(input: OnDemandViewInput): string {
  const source = SOURCE_LABEL[input.source] ?? input.source;
  const list = input.domains.length > 0 ? input.domains.join(", ") : "无（全部常驻）";
  return `实际生效：${list} · 来源：${source}`;
}

/**
 * 勾选 memory/orchestrator 时的提示（不禁止，只提醒）。返回 null 表示不需要提示。
 */
export function onDemandWarning(domains: readonly string[]): string | null {
  const risky = domains.filter((domain) =>
    (ON_DEMAND_NEGATIVE_HINT_DOMAINS as readonly string[]).includes(domain)
  );
  if (risky.length === 0) return null;
  return (
    `${risky.join(" / ")} 实测按需是负收益（激活的一次性开销盖过稳态节省），` +
    "建议只对无缓存能力的 provider 或超长会话开启。"
  );
}

/** 环境变量生效时，设置项被覆盖（UI 据此禁用勾选并解释原因）。 */
export function isSettingsOverriddenByEnv(source: OnDemandSource): boolean {
  return source === "env";
}

/** 勾选 → 写回设置项的顺序（固定顺序，避免数组顺序抖动）。 */
export function normalizeOnDemandSelection(selected: readonly string[]): string[] {
  const wanted = new Set(selected);
  return ON_DEMAND_DOMAIN_OPTIONS.map((option) => option.value).filter((value) => wanted.has(value));
}
