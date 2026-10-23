import { SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { createPiRuntime } from "../../../lib/pi-runtime.ts";
import { readDesktopSettings } from "../../../lib/desktop-settings.ts";
import { pickAutoTargets } from "../../../lib/model-routing.ts";

export const dynamic = "force-dynamic";

export async function GET() {
  const nameMap = new Map<string, string>();
  let modelList: { id: string; name: string; provider: string; input?: string[] }[] = [];
  let defaultModel: { provider: string; modelId: string } | null = null;
  const thinkingLevels: Record<string, string[]> = {};
  const thinkingLevelMaps: Record<string, Record<string, string | null>> = {};
  let autoRouting: ReturnType<typeof pickAutoTargets> = { fast: null, strong: null };

  try {
    const agentDir = getAgentDir();
    const { registry } = await createPiRuntime();
    const available = registry.getAvailable();
    modelList = available.map((m: { id: string; name: string; provider: string; input?: string[] }) => ({
      id: m.id,
      name: m.name,
      provider: m.provider,
      input: m.input,
    }));
    for (const m of available) {
      const key = `${m.provider}:${m.id}`;
      nameMap.set(key, m.name);
      thinkingLevels[key] = getSupportedThinkingLevels(m);
      if (m.thinkingLevelMap) thinkingLevelMaps[key] = m.thinkingLevelMap;
    }

    const settings = SettingsManager.create(process.cwd(), agentDir);
    const provider = settings.getDefaultProvider();
    const modelId = settings.getDefaultModel();
    if (provider) {
      defaultModel = { provider, modelId: modelId ?? available[0]?.id ?? "" };
    }
    autoRouting = pickAutoTargets(
      available.map((m: { id: string; name: string; provider: string }) => ({
        id: m.id,
        name: m.name,
        provider: m.provider,
      })),
      defaultModel ?? undefined,
    );

    // User-picked Auto targets win, but only when they are still available.
    const desktopSettings = readDesktopSettings(agentDir);
    const availableKeys = new Set(
      available.map((m: { id: string; provider: string }) => `${m.provider}:${m.id}`),
    );
    const fast = desktopSettings.autoRoutingFast;
    const strong = desktopSettings.autoRoutingStrong;
    if (fast && availableKeys.has(`${fast.provider}:${fast.modelId}`)) {
      autoRouting.fast = { provider: fast.provider, modelId: fast.modelId };
    }
    if (strong && availableKeys.has(`${strong.provider}:${strong.modelId}`)) {
      autoRouting.strong = { provider: strong.provider, modelId: strong.modelId };
    }
  } catch { /* return empty */ }

  return Response.json({
    models: Object.fromEntries(nameMap),
    modelList,
    defaultModel,
    thinkingLevels,
    thinkingLevelMaps,
    autoRouting,
  });
}
