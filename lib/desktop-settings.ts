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

export interface DesktopSettings {
  defaultAgentMode: AgentMode;
  defaultToolPreset: ToolPreset;
  codemodeEnabled?: boolean;
  /** User-picked fast/strong models for the "Auto" routing mode. */
  autoRoutingFast?: AutoRoutingModelSelection;
  autoRoutingStrong?: AutoRoutingModelSelection;
  /** Optional LTM config; omitted when unset. Merged by getLtmConfig. */
  ltm?: DesktopLtmSettings;
}

const DESKTOP_SETTINGS_FILENAME = "desktop-settings.json";

export function defaultDesktopSettings(): DesktopSettings {
  return {
    defaultAgentMode: DEFAULT_AGENT_MODE,
    defaultToolPreset: DEFAULT_TOOL_PRESET,
    codemodeEnabled: false,
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
  result.codemodeEnabled = typeof obj.codemodeEnabled === "boolean" ? obj.codemodeEnabled : false;
  const fast = parseAutoRoutingSelection(obj.autoRoutingFast);
  const strong = parseAutoRoutingSelection(obj.autoRoutingStrong);
  if (fast) result.autoRoutingFast = fast;
  if (strong) result.autoRoutingStrong = strong;
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
  if (obj.defaultAgentMode !== undefined && !isAgentMode(obj.defaultAgentMode)) {
    return "defaultAgentMode must be plan | ask | full";
  }
  if (obj.defaultToolPreset !== undefined && !isToolPreset(obj.defaultToolPreset)) {
    return "defaultToolPreset must be none | default | full";
  }
  for (const key of ["autoRoutingFast", "autoRoutingStrong"] as const) {
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
