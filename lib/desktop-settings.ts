/**
 * Desktop-only defaults stored at ~/.pi/agent/desktop-settings.json
 * (separate from pi settings.json).
 */
import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { writeFileAtomic } from "./atomic-write.ts";
import {
  DEFAULT_AGENT_MODE,
  DEFAULT_TOOL_PRESET,
  isAgentMode,
  isToolPreset,
  type AgentMode,
  type ToolPreset,
} from "./approval-policy.ts";

/** Optional nested LTM overrides in desktop-settings.json (`ltm`). */
export interface DesktopLtmSettings {
  enabled?: boolean;
  dbPath?: string;
  observeAgentEnd?: boolean;
  observePreCompact?: boolean;
}

export interface AutoRoutingModelSelection {
  provider: string;
  modelId: string;
}

/** Auxiliary (non-chat) model selection: image generation or decision/classifier. */
export type AuxModelSelection = AutoRoutingModelSelection;

/**
 * `on`：普通工具照常声明给模型，脚本只是第二种调用方式。
 * `only`：工具不再声明，全部经脚本调用 —— 提示词里少一整套工具 schema，
 * 且天然逼出「一次脚本办多件事」的批量调用（调用次数下降的主要杠杆）。
 */
export type CodemodeMode = "on" | "only";

export const CODEMODE_MODES: readonly CodemodeMode[] = ["on", "only"];

export function isCodemodeMode(value: unknown): value is CodemodeMode {
  return value === "on" || value === "only";
}

/** codemode worker 池上限的合法区间（SDK 默认 2）。 */
export const CODEMODE_MAX_WORKERS_MIN = 1;
export const CODEMODE_MAX_WORKERS_MAX = 8;

export function isCodemodeMaxWorkers(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= CODEMODE_MAX_WORKERS_MIN &&
    value <= CODEMODE_MAX_WORKERS_MAX
  );
}

export interface DesktopSettings {
  defaultAgentMode: AgentMode;
  defaultToolPreset: ToolPreset;
  codemodeEnabled?: boolean;
  /** `codemodeEnabled` 打开时工具如何呈现给模型（默认 `on`：工具照常声明）。 */
  codemodeMode?: CodemodeMode;
  /**
   * codemode worker 池上限（1–8）。缺省时跟随 `PI_CODEMODE_MAX_WORKERS`，都没有就是 2。
   * SDK 每次执行脚本都会重读该环境变量，所以改完从下一条脚本起生效（无需重启 Host）。
   */
  codemodeMaxWorkers?: number;
  /** User-picked fast/strong models for the "Auto" routing mode. */
  autoRoutingFast?: AutoRoutingModelSelection;
  autoRoutingStrong?: AutoRoutingModelSelection;
  /** Image-generation model used by the `generate_image` tool. */
  imageModel?: AuxModelSelection;
  /** Classifier model used by the `classify_decision` tool. */
  decisionModel?: AuxModelSelection;
  /** Allow web_preview to read page text / screenshots (default off). */
  browserReadEnabled?: boolean;
  /** Allow web_preview to open / navigate the built-in browser (default off). */
  browserInteractEnabled?: boolean;
  /**
   * 输出风格约束（反废话/禁止复述问题/只给 diff…）默认开。关掉只是不再把这
   * 些 bullets 放进 system prompt —— 它是**用户可感知**的输出风格开关，不是省钱开关。
   */
  outputStyleGuidelines?: boolean;
  /** 回复语言跟随用户语言（默认开）。 */
  responseLanguageGuideline?: boolean;
  /**
   * 多会话协作协议（先看 git / 每步提交 / 见到署名先 diff / 独立活走 worktree）
   * 默认开。关掉只是不再把这几个 bullets 放进 system prompt。
   */
  collabGuidelines?: boolean;
  /**
   * 哪些多态工具域走「按需激活」（默认只有 shell）。
   * 环境变量 `PIFORGE_ON_DEMAND_DOMAINS` 优先于这里（CI / 调试用）。
   */
  onDemandDomains?: string[];
  /** Optional LTM config; omitted when unset. Merged by getLtmConfig. */
  ltm?: DesktopLtmSettings;
  /**
   * 项目隔离（默认关）。开启后 Host 的文件授权只放行「当前项目」目录内的路径，
   * 别的项目/任意目录一律 AccessDenied —— 一个项目的会话不能随手读另一个项目。
   */
  projectIsolation?: boolean;
}

const DESKTOP_SETTINGS_FILENAME = "desktop-settings.json";

export function defaultDesktopSettings(): DesktopSettings {
  return {
    defaultAgentMode: DEFAULT_AGENT_MODE,
    defaultToolPreset: DEFAULT_TOOL_PRESET,
    // 批量执行层默认开：模型一次脚本内做完全部读/查/并行调用，而不是逐个工具往返。
    codemodeEnabled: true,
    // 默认 `on`：工具照常逐条声明给模型，脚本只是第二种调用方式 ——
    // `only` 会让工具输出只能整批返回，长命令期间界面空转，故不作默认。
    codemodeMode: "on",
    // Browser capabilities are explicit opt-ins for the agent.
    browserReadEnabled: false,
    browserInteractEnabled: false,
  };
}

function desktopSettingsPath(agentDir: string): string {
  return join(agentDir, DESKTOP_SETTINGS_FILENAME);
}

function parseAutoRoutingSelection(raw: unknown): AutoRoutingModelSelection | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.provider !== "string" || !obj.provider.trim()) return undefined;
  if (typeof obj.modelId !== "string" || !obj.modelId.trim()) return undefined;
  return { provider: obj.provider.trim(), modelId: obj.modelId.trim() };
}

function mergeDesktopLtmSettings(raw: unknown): DesktopLtmSettings | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const out: DesktopLtmSettings = {};
  if (typeof o.enabled === "boolean") out.enabled = o.enabled;
  if (typeof o.dbPath === "string") out.dbPath = o.dbPath;
  if (typeof o.observeAgentEnd === "boolean") out.observeAgentEnd = o.observeAgentEnd;
  if (typeof o.observePreCompact === "boolean") out.observePreCompact = o.observePreCompact;
  return Object.keys(out).length > 0 ? out : undefined;
}

export function mergeDesktopSettings(raw: unknown): DesktopSettings {
  const base = defaultDesktopSettings();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  const obj = raw as Record<string, unknown>;
  const ltm = mergeDesktopLtmSettings(obj.ltm);
  const result: DesktopSettings = {
    defaultAgentMode: isAgentMode(obj.defaultAgentMode) ? obj.defaultAgentMode : base.defaultAgentMode,
    defaultToolPreset: isToolPreset(obj.defaultToolPreset)
      ? obj.defaultToolPreset
      : base.defaultToolPreset,
  };
  if (ltm) result.ltm = ltm;
  result.codemodeEnabled =
    typeof obj.codemodeEnabled === "boolean" ? obj.codemodeEnabled : base.codemodeEnabled === true;
  result.codemodeMode = isCodemodeMode(obj.codemodeMode) ? obj.codemodeMode : base.codemodeMode;
  // 只有显式写过合法值才落盘；没写过就保持 undefined（交给环境变量 / SDK 默认）。
  const maxWorkers = obj.codemodeMaxWorkers;
  if (isCodemodeMaxWorkers(maxWorkers)) result.codemodeMaxWorkers = maxWorkers;
  else if (maxWorkers === null) {
    // 显式选「跟随环境」：不落这个字段，池大小交回 env / SDK 默认。
  } else if (isCodemodeMaxWorkers(base.codemodeMaxWorkers)) {
    result.codemodeMaxWorkers = base.codemodeMaxWorkers;
  }
  result.browserReadEnabled = obj.browserReadEnabled === true;
  result.browserInteractEnabled = obj.browserInteractEnabled === true;
  if (typeof obj.outputStyleGuidelines === "boolean") {
    result.outputStyleGuidelines = obj.outputStyleGuidelines;
  }
  if (typeof obj.responseLanguageGuideline === "boolean") {
    result.responseLanguageGuideline = obj.responseLanguageGuideline;
  }
  if (typeof obj.collabGuidelines === "boolean") {
    result.collabGuidelines = obj.collabGuidelines;
  }
  // 默认关：不写就是 undefined，授权回落成「所有会话 cwd 都可访问」的旧行为。
  if (typeof obj.projectIsolation === "boolean") {
    result.projectIsolation = obj.projectIsolation;
  }
  if (Array.isArray(obj.onDemandDomains)) {
    const allowed = new Set(["browser", "shell", "fleet", "memory", "orchestrator", "plugin"]);
    result.onDemandDomains = [...new Set(obj.onDemandDomains.filter(
      (name): name is string => typeof name === "string" && allowed.has(name)
    ))];
  }
  const fast = parseAutoRoutingSelection(obj.autoRoutingFast);
  const strong = parseAutoRoutingSelection(obj.autoRoutingStrong);
  if (fast) result.autoRoutingFast = fast;
  if (strong) result.autoRoutingStrong = strong;
  const imageModel = parseAutoRoutingSelection(obj.imageModel);
  const decisionModel = parseAutoRoutingSelection(obj.decisionModel);
  if (imageModel) result.imageModel = imageModel;
  if (decisionModel) result.decisionModel = decisionModel;
  return result;
}

export function readDesktopSettings(agentDir: string): DesktopSettings {
  const path = desktopSettingsPath(agentDir);
  if (!existsSync(path)) return defaultDesktopSettings();
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return mergeDesktopSettings(parsed);
  } catch {
    return defaultDesktopSettings();
  }
}

export function writeDesktopSettings(agentDir: string, settings: DesktopSettings): DesktopSettings {
  const merged = mergeDesktopSettings(settings);
  const path = desktopSettingsPath(agentDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}

/** Validate PUT body; returns error string or null. */
export function validateDesktopSettingsBody(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "Body must be an object";
  }
  const obj = body as Record<string, unknown>;
  if (obj.codemodeEnabled !== undefined && typeof obj.codemodeEnabled !== "boolean") {
    return "codemodeEnabled must be a boolean";
  }
  if (obj.codemodeMode !== undefined && !isCodemodeMode(obj.codemodeMode)) {
    return "codemodeMode must be on | only";
  }
  // `null` 是合法的「清空」指令：回到跟随环境变量 / SDK 默认。
  if (
    obj.codemodeMaxWorkers !== undefined &&
    obj.codemodeMaxWorkers !== null &&
    !isCodemodeMaxWorkers(obj.codemodeMaxWorkers)
  ) {
    return `codemodeMaxWorkers must be an integer between ${CODEMODE_MAX_WORKERS_MIN} and ${CODEMODE_MAX_WORKERS_MAX}`;
  }
  for (const key of [
    "browserReadEnabled",
    "browserInteractEnabled",
    "outputStyleGuidelines",
    "responseLanguageGuideline",
    "collabGuidelines",
    "projectIsolation",
  ] as const) {
    if (obj[key] !== undefined && typeof obj[key] !== "boolean") {
      return `${key} must be a boolean`;
    }
  }
  if (obj.defaultAgentMode !== undefined && !isAgentMode(obj.defaultAgentMode)) {
    return "defaultAgentMode must be plan | ask | full";
  }
  if (obj.defaultToolPreset !== undefined && !isToolPreset(obj.defaultToolPreset)) {
    return "defaultToolPreset must be none | default | full";
  }
  for (const key of ["autoRoutingFast", "autoRoutingStrong", "imageModel", "decisionModel"] as const) {
    const value = obj[key];
    if (value === undefined || value === null) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return `${key} must be an object or null`;
    }
    const selection = value as Record<string, unknown>;
    if (typeof selection.provider !== "string" || !selection.provider.trim()) {
      return `${key}.provider must be a non-empty string`;
    }
    if (typeof selection.modelId !== "string" || !selection.modelId.trim()) {
      return `${key}.modelId must be a non-empty string`;
    }
  }
  if (obj.onDemandDomains !== undefined) {
    if (!Array.isArray(obj.onDemandDomains) || !obj.onDemandDomains.every((name) => typeof name === "string")) {
      return "onDemandDomains must be an array of strings";
    }
    const allowed = ["browser", "shell", "fleet", "memory", "orchestrator", "plugin"];
    if (!obj.onDemandDomains.every((name) => allowed.includes(name as string))) {
      return `onDemandDomains only accepts: ${allowed.join(", ")}`;
    }
  }
  if (obj.ltm !== undefined) {
    if (!obj.ltm || typeof obj.ltm !== "object" || Array.isArray(obj.ltm)) {
      return "ltm must be an object";
    }
    const ltm = obj.ltm as Record<string, unknown>;
    if (ltm.enabled !== undefined && typeof ltm.enabled !== "boolean") {
      return "ltm.enabled must be a boolean";
    }
    if (ltm.dbPath !== undefined && typeof ltm.dbPath !== "string") {
      return "ltm.dbPath must be a string";
    }
    if (ltm.observeAgentEnd !== undefined && typeof ltm.observeAgentEnd !== "boolean") {
      return "ltm.observeAgentEnd must be a boolean";
    }
    if (
      ltm.observePreCompact !== undefined &&
      typeof ltm.observePreCompact !== "boolean"
    ) {
      return "ltm.observePreCompact must be a boolean";
    }
  }
  return null;
}
