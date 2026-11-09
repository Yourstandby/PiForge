/**
 * 场景档案（方案 A）：把「常规 / 私密」两套模型配置固化成可一键切换的快照。
 *
 * 私密档案的语义是**硬约束**：五个会发请求的通道（主对话、Auto 快档、Auto 强档、
 * 生图、决策）必须全部指向本地/内网端点；任何一个通道指向云端，切换就必须失败，
 * 而不是带着漏洞切过去。网页读取/交互权限在私密场景下强制关闭。
 *
 * 这里只放纯逻辑：端点数判定、档案审计、应用档案。文件读写与 RPC 留给调用方。
 */
import type { DesktopSettings } from "./desktop-settings.ts";

export type SceneName = "normal" | "private";

export const SCENE_NAMES: readonly SceneName[] = ["normal", "private"];

export function isSceneName(value: unknown): value is SceneName {
  return value === "normal" || value === "private";
}

export interface SceneModelRef {
  provider: string;
  modelId: string;
}

/** 会真正把会话内容发出去的通道。全部显式指向本地才算私密。 */
export const SCENE_MODEL_LANES = [
  "model",
  "autoRoutingFast",
  "autoRoutingStrong",
  "imageModel",
  "decisionModel",
] as const;

export type SceneModelLane = (typeof SCENE_MODEL_LANES)[number];

export type SceneLane = SceneModelLane;

export interface SceneProfile {
  /** 主对话模型（新会话默认模型 + 私密场景下的强制目标）。 */
  model?: SceneModelRef;
  autoRoutingFast?: SceneModelRef;
  autoRoutingStrong?: SceneModelRef;
  imageModel?: SceneModelRef;
  decisionModel?: SceneModelRef;
  browserReadEnabled?: boolean;
  browserInteractEnabled?: boolean;
}

export interface SceneProfiles {
  normal?: SceneProfile;
  private?: SceneProfile;
}

/** 端点判定时额外认可的本地 Provider 标识（没配 baseUrl 也能认出来的那些）。 */
const LOCAL_PROVIDER_IDS = new Set([
  "ollama",
  "ollama-local",
  "lmstudio",
  "lm-studio",
  "llamacpp",
  "llama-cpp",
  "vllm",
  "local",
  "localai",
]);

/** 没配 baseUrl 也能认出来的云端 Provider：一律算「会出网」，不用再问地址。 */
const CLOUD_PROVIDER_IDS = new Set([
  "deepseek",
  "openai",
  "anthropic",
  "google",
  "gemini",
  "groq",
  "mistral",
  "moonshot",
  "kimi",
  "zhipu",
  "glm",
  "openrouter",
  "xai",
  "grok",
  "together",
  "fireworks",
  "qwen",
  "dashscope",
  "siliconflow",
  "volces",
  "volcengine",
  "azure-openai",
  "bedrock",
  "vertex",
]);

const LOCAL_HOSTNAMES = new Set([
  "localhost",
  "::1",
  "[::1]",
  "0.0.0.0",
  "host.docker.internal",
  "host.containers.internal",
]);

/** 端点是否本地/内网。解析不了的地址一律按「不本地」处理。 */
export function isLocalEndpoint(baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return false;
  const raw = baseUrl.trim();
  if (!raw) return false;
  let host: string;
  try {
    host = new URL(raw.includes("://") ? raw : `http://${raw}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host) return false;
  if (LOCAL_HOSTNAMES.has(host)) return true;
  if (host.startsWith("127.")) return true;
  if (host.startsWith("10.")) return true;
  if (host.startsWith("192.168.")) return true;
  if (host.startsWith("169.254.")) return true;
  const privateB = /^172\.(\d{1,3})\./.exec(host);
  if (privateB) {
    const second = Number(privateB[1]);
    if (second >= 16 && second <= 31) return true;
  }
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan")) return true;
  // IPv6 唯一本地地址 fc00::/7
  if (host.startsWith("fc") || host.startsWith("fd")) return true;
  return false;
}

export type SceneIssueReason = "unset" | "unknown-provider" | "non-local";

export interface SceneLaneIssue {
  lane: SceneLane;
  reason: SceneIssueReason;
  provider?: string;
  modelId?: string;
  baseUrl?: string;
}

export interface SceneAudit {
  ok: boolean;
  issues: SceneLaneIssue[];
  /** 审计时判定为本地/内网的 provider id，便于 UI 直接展示。 */
  localProviders: string[];
}

/**
 * 审计一个档案是否能安全地当「私密」用。
 * `providerBaseUrls` 来自自定义 Provider 表（id → baseUrl）；表里没有的 provider
 * 只能靠 LOCAL_PROVIDER_IDS 兜底，否则按未知处理 —— 宁可挡住也不要放行。
 */
export function auditSceneProfile(
  profile: SceneProfile | undefined,
  providerBaseUrls: Record<string, string | undefined> = {},
): SceneAudit {
  const issues: SceneLaneIssue[] = [];
  const localProviders = new Set<string>();
  const seen = new Set<string>();
  for (const [id, url] of Object.entries(providerBaseUrls)) {
    if (url && isLocalEndpoint(url)) localProviders.add(id);
  }
  if (!profile) {
    for (const lane of SCENE_MODEL_LANES) issues.push({ lane, reason: "unset" });
    return { ok: false, issues, localProviders: [...localProviders] };
  }
  for (const lane of SCENE_MODEL_LANES) {
    const ref = profile[lane];
    if (!ref || !ref.provider.trim() || !ref.modelId.trim()) {
      issues.push({ lane, reason: "unset" });
      continue;
    }
    seen.add(ref.provider);
    const baseUrl = providerBaseUrls[ref.provider];
    if (baseUrl) {
      if (!isLocalEndpoint(baseUrl)) {
        issues.push({ lane, reason: "non-local", provider: ref.provider, modelId: ref.modelId, baseUrl });
      } else {
        localProviders.add(ref.provider);
      }
      continue;
    }
    const normalized = ref.provider.toLowerCase();
    if (LOCAL_PROVIDER_IDS.has(normalized)) {
      localProviders.add(ref.provider);
      continue;
    }
    issues.push({
      lane,
      reason: CLOUD_PROVIDER_IDS.has(normalized) ? "non-local" : "unknown-provider",
      provider: ref.provider,
      modelId: ref.modelId,
    });
  }
  return { ok: issues.length === 0, issues, localProviders: [...localProviders] };
}

/** 把**当前生效**的通道抓成快照 —— 切走之前先存一份，切回来才能原样恢复。 */
export function snapshotSceneLanes(settings: DesktopSettings): SceneProfile {
  const profile: SceneProfile = {};
  for (const lane of ["autoRoutingFast", "autoRoutingStrong", "imageModel", "decisionModel"] as const) {
    const ref = settings[lane];
    if (ref) profile[lane] = { provider: ref.provider, modelId: ref.modelId };
  }
  if (settings.browserReadEnabled !== undefined) profile.browserReadEnabled = settings.browserReadEnabled;
  if (settings.browserInteractEnabled !== undefined) {
    profile.browserInteractEnabled = settings.browserInteractEnabled;
  }
  return profile;
}

/** 把档案落到桌面设置上。私密场景顺手关掉网页读取/交互（不会被档案里的 true 覆盖回去）。 */
export function applySceneProfile(
  current: DesktopSettings,
  scene: SceneName,
  profile: SceneProfile | undefined,
): DesktopSettings {
  const next: DesktopSettings = { ...current, activeScene: scene };
  if (!profile) return next;
  for (const lane of ["autoRoutingFast", "autoRoutingStrong", "imageModel", "decisionModel"] as const) {
    const ref = profile[lane];
    if (ref) next[lane] = { provider: ref.provider, modelId: ref.modelId };
  }
  if (scene === "private") {
    next.browserReadEnabled = false;
    next.browserInteractEnabled = false;
  } else if (profile.browserReadEnabled !== undefined) {
    next.browserReadEnabled = profile.browserReadEnabled;
  }
  if (scene === "normal" && profile.browserInteractEnabled !== undefined) {
    next.browserInteractEnabled = profile.browserInteractEnabled;
  }
  return next;
}

/** 场景生效时的主对话模型（只认档案里的 model）。 */
export function sceneModel(profile: SceneProfile | undefined): SceneModelRef | null {
  const ref = profile?.model;
  if (!ref || !ref.provider.trim() || !ref.modelId.trim()) return null;
  return { provider: ref.provider.trim(), modelId: ref.modelId.trim() };
}

/**
 * 从当前可用模型里给私密档案挑一套默认通道：全部落在同一个本地 Provider 的第一个模型上。
 * 找不到本地 Provider 就返回 null，让 UI 引导用户先配 Ollama / 自建网关。
 */
export function draftPrivateProfile(
  models: { provider: string; id: string }[],
  providerBaseUrls: Record<string, string | undefined> = {},
): { profile: SceneProfile; provider: string; modelId: string } | null {
  for (const [provider, baseUrl] of Object.entries(providerBaseUrls)) {
    if (!baseUrl || !isLocalEndpoint(baseUrl)) continue;
    const first = models.find((m) => m.provider === provider);
    if (!first) continue;
    return {
      provider,
      modelId: first.id,
      profile: {
        model: { provider, modelId: first.id },
        autoRoutingFast: { provider, modelId: first.id },
        autoRoutingStrong: { provider, modelId: first.id },
        imageModel: { provider, modelId: first.id },
        decisionModel: { provider, modelId: first.id },
      },
    };
  }
  for (const provider of LOCAL_PROVIDER_IDS) {
    const first = models.find((m) => m.provider.toLowerCase() === provider);
    if (!first) continue;
    return {
      provider: first.provider,
      modelId: first.id,
      profile: {
        model: { provider: first.provider, modelId: first.id },
        autoRoutingFast: { provider: first.provider, modelId: first.id },
        autoRoutingStrong: { provider: first.provider, modelId: first.id },
        imageModel: { provider: first.provider, modelId: first.id },
        decisionModel: { provider: first.provider, modelId: first.id },
      },
    };
  }
  return null;
}

/** 供 UI 说明用的通道中文名。 */
export const SCENE_LANE_LABELS: Record<SceneModelLane, string> = {
  model: "主对话",
  autoRoutingFast: "Auto 快档",
  autoRoutingStrong: "Auto 强档",
  imageModel: "生图",
  decisionModel: "决策/分类",
};
