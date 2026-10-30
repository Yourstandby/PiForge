/**
 * 项目级开关，按 cwd 索引，文件 `~/.pi/agent/project-settings.json`。
 *
 * 为什么不写进项目目录：pi 把 `.pi/` 下任一配置条目视为「需要信任的项目资源」，
 * 一旦落盘就会给该项目触发 trust 409；放到 agent 目录则完全不碰项目本身。
 *
 * 语义：字段缺省 = **跟随全局设置**；显式 true / false 才覆盖。
 */
import { existsSync, mkdirSync, readFileSync, realpathSync } from "fs";
import { join, resolve } from "path";
import { writeFileAtomic } from "./atomic-write.ts";

export interface ProjectSettings {
  /** 上下文文件（AGENTS.md / CLAUDE.md）注入。undefined = 跟随全局。 */
  contextFiles?: boolean;
  /** HANDOFF.md 接续注入。undefined = 跟随全局。 */
  handoff?: boolean;
}

/** 写入补丁：null = 清除该键（回到跟随全局）。 */
export interface ProjectSwitches {
  contextFiles?: boolean | null;
  handoff?: boolean | null;
}

const PROJECT_SWITCH_KEYS = ["contextFiles", "handoff"] as const;

export type ProjectSettingsMap = Record<string, ProjectSettings>;

const PROJECT_SETTINGS_FILENAME = "project-settings.json";

/**
 * cwd → 存储键：先 resolve，能 realpath 就用 realpath（同一目录换个软链/大小写
 * 不该变成两份配置），Windows 上再统一小写。
 */
export function projectSettingsKey(cwd: string): string {
  let key = resolve(cwd);
  try {
    key = realpathSync.native(key);
  } catch {
    // 目录还不存在：用 resolve 的结果即可。
  }
  return process.platform === "win32" ? key.toLowerCase() : key;
}

export function projectSettingsPath(agentDir: string): string {
  return join(agentDir, PROJECT_SETTINGS_FILENAME);
}

function parseProjectSettings(raw: unknown): ProjectSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;
  const out: ProjectSettings = {};
  for (const key of PROJECT_SWITCH_KEYS) {
    if (typeof obj[key] === "boolean") out[key] = obj[key] as boolean;
  }
  return out;
}

export function readProjectSettings(agentDir: string): ProjectSettingsMap {
  const path = projectSettingsPath(agentDir);
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const projects = (parsed as { projects?: unknown }).projects;
    if (!projects || typeof projects !== "object" || Array.isArray(projects)) return {};
    const out: ProjectSettingsMap = {};
    for (const [key, value] of Object.entries(projects as Record<string, unknown>)) {
      const parsedEntry = parseProjectSettings(value);
      if (Object.keys(parsedEntry).length > 0) out[key] = parsedEntry;
    }
    return out;
  } catch {
    return {};
  }
}

export function readProjectSetting(agentDir: string, cwd: string): ProjectSettings {
  return readProjectSettings(agentDir)[projectSettingsKey(cwd)] ?? {};
}

/**
 * 写入单个项目的开关。`contextFiles: null` 表示删掉该字段（回到跟随全局），
 * 整个项目条目空了就把键也去掉，文件里不留噪音。
 */
export function writeProjectSetting(
  agentDir: string,
  cwd: string,
  patch: ProjectSwitches,
): ProjectSettings {
  const all = readProjectSettings(agentDir);
  const key = projectSettingsKey(cwd);
  const next: ProjectSettings = { ...(all[key] ?? {}) };
  for (const field of PROJECT_SWITCH_KEYS) {
    const value = patch[field];
    if (value === null) delete next[field];
    else if (typeof value === "boolean") next[field] = value;
  }
  if (Object.keys(next).length > 0) all[key] = next;
  else delete all[key];
  const path = projectSettingsPath(agentDir);
  mkdirSync(agentDir, { recursive: true });
  writeFileAtomic(path, `${JSON.stringify({ projects: all }, null, 2)}\n`);
  return next;
}

/**
 * 生效值：项目级 > 全局 > 默认开。
 * 全局字段缺省也当开 —— 关掉 AGENTS.md 是要主动做的事，不能因为老配置文件没这个字段就默默失效。
 */
export interface GlobalSwitches {
  contextFilesEnabled?: boolean;
  handoffEnabled?: boolean;
}

export function resolveContextFilesEnabled(
  agentDir: string,
  cwd: string,
  desktop?: GlobalSwitches,
): boolean {
  const project = readProjectSetting(agentDir, cwd);
  if (typeof project.contextFiles === "boolean") return project.contextFiles;
  if (typeof desktop?.contextFilesEnabled === "boolean") return desktop.contextFilesEnabled;
  return true;
}

/** HANDOFF 接续注入：项目级 > 全局 > 默认开（没有交接文件时不会注入任何东西）。 */
export function resolveHandoffEnabled(
  agentDir: string,
  cwd: string,
  desktop?: GlobalSwitches,
): boolean {
  const project = readProjectSetting(agentDir, cwd);
  if (typeof project.handoff === "boolean") return project.handoff;
  if (typeof desktop?.handoffEnabled === "boolean") return desktop.handoffEnabled;
  return true;
}
