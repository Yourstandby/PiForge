import { NextResponse } from "../../../lib/next-server-shim.ts";
import { SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { errorMessage, getRequestId, jsonError, logApiError } from "../../../lib/api-error.ts";

export const dynamic = "force-dynamic";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const MODES = ["all", "one-at-a-time"] as const;
const CACHE_WARMING_MODES = ["off", "warm"] as const;

interface SettingsSnapshot {
  defaultThinkingLevel: string;
  steeringMode: string;
  followUpMode: string;
  hideThinkingBlock: boolean;
  showCacheMissNotices: boolean;
  compactionEnabled: boolean;
  retryEnabled: boolean;
  cacheWarming: string;
  showImages: boolean;
  enableSkillCommands: boolean;
}

function snapshot(manager: SettingsManager): SettingsSnapshot {
  const settings = manager.getSettings() as Record<string, unknown> & {
    compaction?: { enabled?: boolean };
    retry?: { enabled?: boolean };
    images?: { show?: boolean };
  };
  return {
    defaultThinkingLevel: String(settings.defaultThinkingLevel ?? "medium"),
    steeringMode: String(settings.steeringMode ?? "one-at-a-time"),
    followUpMode: String(settings.followUpMode ?? "one-at-a-time"),
    hideThinkingBlock: settings.hideThinkingBlock === true,
    showCacheMissNotices: settings.showCacheMissNotices === true,
    compactionEnabled: settings.compaction?.enabled !== false,
    retryEnabled: settings.retry?.enabled !== false,
    // 真实生效的模式（未显式设置时是 pi 的默认值），不要再把 undefined 显示成 off。
    cacheWarming: manager.getCacheWarmingMode(),
    showImages: settings.images?.show !== false,
    enableSkillCommands: settings.enableSkillCommands === true,
  };
}

export async function GET(req: Request) {
  const requestId = getRequestId(req);
  try {
    const manager = SettingsManager.create(process.cwd(), getAgentDir());
    return NextResponse.json(snapshot(manager), { headers: { "x-request-id": requestId } });
  } catch (error) {
    logApiError({ route: "/api/settings", method: "GET", requestId, error });
    return jsonError(req, 500, errorMessage(error));
  }
}

export async function PUT(req: Request) {
  const requestId = getRequestId(req);
  try {
    const body = (await req.json()) as Partial<SettingsSnapshot>;
    const manager = SettingsManager.create(process.cwd(), getAgentDir());

    if (body.defaultThinkingLevel !== undefined) {
      if (!THINKING_LEVELS.includes(body.defaultThinkingLevel as (typeof THINKING_LEVELS)[number])) {
        return jsonError(req, 400, "invalid defaultThinkingLevel");
      }
      manager.setDefaultThinkingLevel(body.defaultThinkingLevel as never);
    }
    if (body.steeringMode !== undefined) {
      if (!MODES.includes(body.steeringMode as (typeof MODES)[number])) {
        return jsonError(req, 400, "invalid steeringMode");
      }
      manager.setSteeringMode(body.steeringMode as never);
    }
    if (body.followUpMode !== undefined) {
      if (!MODES.includes(body.followUpMode as (typeof MODES)[number])) {
        return jsonError(req, 400, "invalid followUpMode");
      }
      manager.setFollowUpMode(body.followUpMode as never);
    }
    if (body.hideThinkingBlock !== undefined) {
      manager.setHideThinkingBlock(body.hideThinkingBlock === true);
    }
    if (body.showCacheMissNotices !== undefined) {
      manager.setShowCacheMissNotices(body.showCacheMissNotices === true);
    }
    if (body.compactionEnabled !== undefined) {
      manager.setCompactionEnabled(body.compactionEnabled === true);
    }
    if (body.retryEnabled !== undefined) {
      manager.setRetryEnabled(body.retryEnabled === true);
    }
    if (body.cacheWarming !== undefined) {
      if (!CACHE_WARMING_MODES.includes(body.cacheWarming as (typeof CACHE_WARMING_MODES)[number])) {
        return jsonError(req, 400, "invalid cacheWarming");
      }
      manager.setCacheWarmingMode(body.cacheWarming as never);
    }
    if (body.showImages !== undefined) {
      manager.setShowImages(body.showImages === true);
    }
    if (body.enableSkillCommands !== undefined) {
      manager.setEnableSkillCommands(body.enableSkillCommands === true);
    }

    await manager.flush();
    return NextResponse.json(snapshot(manager), { headers: { "x-request-id": requestId } });
  } catch (error) {
    logApiError({ route: "/api/settings", method: "PUT", requestId, error });
    return jsonError(req, 500, errorMessage(error));
  }
}
