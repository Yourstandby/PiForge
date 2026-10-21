/**
 * 舰队（Fleet）Agent 配置持久化。
 *
 * 与「临时子 Agent」的区别就在这一层：临时子 Agent 用完即销毁，**不落盘**；
 * 舰队 Agent 是一份可以反复唤醒的配置（名字、System Prompt、工具权限），
 * 存在 `<agentDir>/fleet/agents.json` 里，重启后原样回显。
 *
 * 这里只管配置，不管运行时：会话仍然由 herdr-manager 在 Host 里创建 / 回收。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FleetAgentProfile } from "../contract/domains/fleet.ts";

/** 允许舰队 Agent 申请的工具：与只读子 Agent 同一套白名单。 */
export const FLEET_ALLOWED_TOOLS = ["read", "grep", "find", "ls"] as const;
/** 舰队规模上限（与 herdr 的 MAX_FLEET 一致，避免 UI 里能建但起不来）。 */
export const MAX_FLEET_PROFILES = 12;
export const MAX_SYSTEM_PROMPT_CHARS = 4_000;
export const MAX_NAME_CHARS = 60;

export interface FleetStoreOptions {
  /** 覆盖配置文件路径（测试用）。 */
  filePath?: string;
}

export class FleetStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FleetStoreError";
  }
}

/** `<agentDir>/fleet/agents.json` */
export function fleetStorePath(agentDir: string): string {
  return join(agentDir, "fleet", "agents.json");
}

let overridePath: string | null = null;

/** 测试钩子：把存储重定向到临时文件。传 null 恢复默认。 */
export function setFleetStorePathForTest(path: string | null): void {
  overridePath = path;
}

function resolvePath(agentDir: string): string {
  return overridePath ?? fleetStorePath(agentDir);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (!name) throw new FleetStoreError("name is required");
  if (name.length > MAX_NAME_CHARS) {
    throw new FleetStoreError(`name must be at most ${MAX_NAME_CHARS} characters`);
  }
  return name;
}

/** 只接受白名单里的工具；未知工具名直接忽略（不阻塞保存，但不会生效）。 */
export function sanitizeFleetTools(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [...FLEET_ALLOWED_TOOLS];
  const wanted = new Set(
    raw.filter((item): item is string => typeof item === "string").map((item) => item.trim()),
  );
  const allowed = FLEET_ALLOWED_TOOLS.filter((tool) => wanted.has(tool));
  return allowed.length > 0 ? allowed : [...FLEET_ALLOWED_TOOLS];
}

function validateProfile(raw: unknown): FleetAgentProfile {
  if (!isRecord(raw)) throw new FleetStoreError("profile must be an object");
  const name = sanitizeName(raw.name);
  const systemPrompt = typeof raw.systemPrompt === "string" ? raw.systemPrompt.trim() : "";
  if (!systemPrompt) throw new FleetStoreError("systemPrompt is required");
  if (systemPrompt.length > MAX_SYSTEM_PROMPT_CHARS) {
    throw new FleetStoreError(`systemPrompt must be at most ${MAX_SYSTEM_PROMPT_CHARS} characters`);
  }
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `fleet-${slug(name)}`;
  const createdAt = typeof raw.createdAt === "number" ? raw.createdAt : Date.now();
  return {
    id,
    name,
    systemPrompt,
    tools: sanitizeFleetTools(raw.tools),
    persistent: raw.persistent !== false,
    createdAt,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : createdAt,
  };
}

function slug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return `${base || "agent"}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface FleetStoreFile {
  version: 1;
  profiles: FleetAgentProfile[];
}

function readFile(file: string): FleetStoreFile {
  if (!existsSync(file)) return { version: 1, profiles: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    const profilesRaw = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed.profiles)
        ? parsed.profiles
        : [];
    const profiles: FleetAgentProfile[] = [];
    for (const item of profilesRaw) {
      try {
        profiles.push(validateProfile(item));
      } catch {
        // 单条坏配置不能连累整份文件。
      }
    }
    return { version: 1, profiles };
  } catch {
    // 文件损坏：当作空配置，下次保存会重建。
    return { version: 1, profiles: [] };
  }
}

function writeFile(file: string, data: FleetStoreFile): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  renameSync(temp, file);
}

/** 列出全部常驻 Agent（按更新时间倒序，新配置在前）。 */
export function listFleetProfiles(agentDir: string): FleetAgentProfile[] {
  const { profiles } = readFile(resolvePath(agentDir));
  return [...profiles].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getFleetProfile(agentDir: string, id: string): FleetAgentProfile | null {
  return listFleetProfiles(agentDir).find((profile) => profile.id === id) ?? null;
}

/** 新建或更新（按 id 或 name 去重）。 */
export function saveFleetProfile(
  agentDir: string,
  input: unknown,
  options: { allowNew?: boolean } = {},
): FleetAgentProfile {
  const file = resolvePath(agentDir);
  const data = readFile(file);
  const draft = validateProfile(input);
  const existingIndex = data.profiles.findIndex(
    (profile) => profile.id === draft.id || profile.name === draft.name,
  );
  const allowNew = options.allowNew !== false;
  if (existingIndex < 0 && !allowNew) {
    throw new FleetStoreError(`No fleet agent named "${draft.name}"`);
  }
  if (existingIndex < 0 && data.profiles.length >= MAX_FLEET_PROFILES) {
    throw new FleetStoreError(`Fleet profile limit reached (${MAX_FLEET_PROFILES})`);
  }
  const merged: FleetAgentProfile =
    existingIndex >= 0
      ? {
          ...data.profiles[existingIndex],
          ...draft,
          id: data.profiles[existingIndex].id,
          createdAt: data.profiles[existingIndex].createdAt,
          updatedAt: Date.now(),
        }
      : { ...draft, updatedAt: Date.now() };
  if (existingIndex >= 0) data.profiles[existingIndex] = merged;
  else data.profiles.push(merged);
  writeFile(file, data);
  return merged;
}

export function deleteFleetProfile(agentDir: string, id: string): boolean {
  const file = resolvePath(agentDir);
  const data = readFile(file);
  const next = data.profiles.filter((profile) => profile.id !== id);
  if (next.length === data.profiles.length) return false;
  writeFile(file, { version: 1, profiles: next });
  return true;
}

/** 从外部 JSON 导入：接受单条、数组、或 `{ profiles: [...] }`。 */
export function importFleetProfiles(agentDir: string, raw: unknown): FleetAgentProfile[] {
  const list = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.profiles)
      ? raw.profiles
      : isRecord(raw)
        ? [raw]
        : [];
  if (list.length === 0) throw new FleetStoreError("导入内容里没有可用的 Agent 配置");
  const saved: FleetAgentProfile[] = [];
  for (const item of list) {
    saved.push(saveFleetProfile(agentDir, item));
  }
  return saved;
}
