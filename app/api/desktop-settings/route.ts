import { NextResponse } from "../../../lib/next-server-shim.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  mergeDesktopSettings,
  readDesktopSettings,
  validateDesktopSettingsBody,
  writeDesktopSettings,
} from "../../../lib/desktop-settings.ts";
import { errorMessage, getRequestId, jsonError, logApiError } from "../../../lib/api-error.ts";
import { getAgentHostClient } from "../../../lib/agent-host-client.ts";
import { resolveOnDemandDomains } from "../../../lib/domain-tools.ts";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const requestId = getRequestId(req);
  try {
    const settings = readDesktopSettings(getAgentDir());
    // 实际生效的按需域（环境变量 > 设置项 > 默认），设置页展示这个而不是原始字段。
    const onDemand = resolveOnDemandDomains({
      env: process.env,
      settings: settings.onDemandDomains ?? null,
    });
    return NextResponse.json(
      {
        ...settings,
        onDemandDomains: settings.onDemandDomains ?? null,
        onDemandEffective: { domains: onDemand.domains, source: onDemand.source },
      },
      { headers: { "x-request-id": requestId } }
    );
  } catch (error) {
    logApiError({ route: "/api/desktop-settings", method: "GET", requestId, error });
    return jsonError(req, 500, errorMessage(error));
  }
}

export async function PUT(req: Request) {
  const requestId = getRequestId(req);
  try {
    const body: unknown = await req.json();
    const err = validateDesktopSettingsBody(body);
    if (err) {
      return jsonError(req, 400, err);
    }
    const agentDir = getAgentDir();
    const current = readDesktopSettings(agentDir);
    const merged = mergeDesktopSettings({ ...current, ...(body as object) });
    const saved = writeDesktopSettings(agentDir, merged);
    void getAgentHostClient()
      .call("agent.updateCodemode", {
        enabled: saved.codemodeEnabled ?? false,
        ...(saved.codemodeMode ? { mode: saved.codemodeMode } : {}),
      })
      .catch(() => {});
    const onDemand = resolveOnDemandDomains({
      env: process.env,
      settings: saved.onDemandDomains ?? null,
    });
    return NextResponse.json(
      {
        ...saved,
        onDemandDomains: saved.onDemandDomains ?? null,
        onDemandEffective: { domains: onDemand.domains, source: onDemand.source },
      },
      { headers: { "x-request-id": requestId } }
    );
  } catch (error) {
    logApiError({ route: "/api/desktop-settings", method: "PUT", requestId, error });
    return jsonError(req, 500, errorMessage(error));
  }
}
