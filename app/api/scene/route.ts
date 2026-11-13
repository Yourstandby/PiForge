import { NextResponse } from "../../../lib/next-server-shim.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  readDesktopSettings,
  validateDesktopSettingsBody,
  writeDesktopSettings,
} from "../../../lib/desktop-settings.ts";
import {
  applySceneProfile,
  auditSceneProfile,
  draftPrivateProfile,
  isLocalEndpoint,
  isSceneName,
  sceneModel,
  snapshotSceneLanes,
  type SceneName,
  type SceneProfile,
} from "../../../lib/scene-profiles.ts";
import { errorMessage, getRequestId, jsonError, logApiError } from "../../../lib/api-error.ts";
import { AgentHostError, getAgentHostClient } from "../../../lib/agent-host-client.ts";
import { createPiRuntime } from "../../../lib/pi-runtime.ts";
import type { CustomProviderView } from "../../../contract/domains/providers.ts";

export const dynamic = "force-dynamic";

/** 自定义 Provider 的 id → baseUrl 映射；Host 不可用时返回空表（审计会更严格）。 */
async function providerBaseUrls(): Promise<Record<string, string>> {
  try {
    const result = await getAgentHostClient().call("models.providers.list", {});
    const providers = (result as { providers?: CustomProviderView[] }).providers ?? [];
    const out: Record<string, string> = {};
    for (const provider of providers) {
      if (provider?.id && provider.baseUrl) out[provider.id] = provider.baseUrl;
    }
    return out;
  } catch {
    return {};
  }
}

interface SceneModelOption {
  provider: string;
  id: string;
  name: string;
}

async function availableModels(): Promise<SceneModelOption[]> {
  try {
    const { registry } = await createPiRuntime();
    return registry
      .getAvailable()
      .map((m: { id: string; name: string; provider: string }) => ({
        provider: m.provider,
        id: m.id,
        name: m.name,
      }));
  } catch {
    return [];
  }
}

export async function GET(req: Request) {
  const requestId = getRequestId(req);
  try {
    const settings = readDesktopSettings(getAgentDir());
    const [baseUrls, models] = await Promise.all([providerBaseUrls(), availableModels()]);
    const profiles = settings.sceneProfiles ?? {};
    const draft = draftPrivateProfile(models, baseUrls);
    return NextResponse.json(
      {
        activeScene: settings.activeScene ?? "normal",
        sceneProfiles: profiles,
        activeModel: sceneModel(profiles[settings.activeScene ?? "normal"]),
        providers: Object.entries(baseUrls).map(([id, baseUrl]) => ({
          id,
          baseUrl,
          local: isLocalEndpoint(baseUrl),
        })),
        models,
        audits: {
          normal: auditSceneProfile(profiles.normal, baseUrls),
          private: auditSceneProfile(profiles.private, baseUrls),
        },
        draft: draft
          ? { provider: draft.provider, modelId: draft.modelId, profile: draft.profile }
          : null,
      },
      { headers: { "x-request-id": requestId } },
    );
  } catch (error) {
    logApiError({ route: "/api/scene", method: "GET", requestId, error });
    return jsonError(req, 500, errorMessage(error));
  }
}

function parseProfile(raw: unknown): SceneProfile | null | undefined {
  // undefined = 请求没带档案；null = 显式清空。
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as SceneProfile;
}

export async function PUT(req: Request) {
  const requestId = getRequestId(req);
  try {
    const body = (await req.json()) as {
      scene?: unknown;
      profile?: unknown;
      saveProfile?: unknown;
    };
    if (!isSceneName(body.scene)) {
      return jsonError(req, 400, "scene must be normal | private");
    }
    const scene: SceneName = body.scene;
    const agentDir = getAgentDir();
    const current = readDesktopSettings(agentDir);
    const incoming = parseProfile(body.profile);
    const profiles = { ...(current.sceneProfiles ?? {}) };
    // 切走之前先把「当前生效」的通道存成离开方的档案：先切私密、再切回常规时，
    // Auto / 生图 / 决策不会永久停留在本地模型上。
    const outgoing: SceneName = current.activeScene ?? "normal";
    if (outgoing !== scene && !profiles[outgoing]) {
      profiles[outgoing] = snapshotSceneLanes(current);
    }
    if (body.saveProfile === true) {
      if (incoming === undefined || incoming === null) delete profiles[scene];
      else profiles[scene] = incoming;
    }
    const profile = incoming === undefined ? profiles[scene] : (incoming ?? undefined);

    if (scene === "private") {
      const baseUrls = await providerBaseUrls();
      const audit = auditSceneProfile(profile, baseUrls);
      if (!audit.ok) {
        // 私密场景不接受「差不多」：任一通道可能出网就拒绝切换。
        return NextResponse.json(
          { error: "私密场景要求所有模型通道指向本地/内网端点", code: "E_SCENE_NOT_PRIVATE", audit },
          { status: 409 },
        );
      }
    }

    const candidate = { ...current, sceneProfiles: profiles };
    const invalid = validateDesktopSettingsBody(candidate);
    if (invalid) return jsonError(req, 400, invalid);

    const next = applySceneProfile(candidate, scene, profile);
    const saved = writeDesktopSettings(agentDir, next);
    return NextResponse.json(
      {
        activeScene: saved.activeScene ?? "normal",
        sceneProfiles: saved.sceneProfiles ?? {},
        activeModel: sceneModel(profile),
        settings: saved,
      },
      { headers: { "x-request-id": requestId } },
    );
  } catch (error) {
    if (error instanceof AgentHostError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 503 });
    }
    logApiError({ route: "/api/scene", method: "PUT", requestId, error });
    return jsonError(req, 500, errorMessage(error));
  }
}
