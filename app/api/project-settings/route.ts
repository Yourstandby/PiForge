import { NextResponse } from "../../../lib/next-server-shim.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readDesktopSettings } from "../../../lib/desktop-settings.ts";
import {
  projectSettingsKey,
  readProjectSetting,
  writeProjectSetting,
  type ProjectSwitches,
} from "../../../lib/project-settings.ts";
import { errorMessage, getRequestId, jsonError, logApiError } from "../../../lib/api-error.ts";

export const dynamic = "force-dynamic";

/** 当前项目的开关 + 生效值（项目级 > 全局 > 默认开）。 */
export async function GET(req: Request) {
  const requestId = getRequestId(req);
  try {
    const url = new URL(req.url);
    const cwd = url.searchParams.get("cwd");
    if (!cwd) return jsonError(req, 400, "cwd is required");
    const agentDir = getAgentDir();
    const project = readProjectSetting(agentDir, cwd);
    const desktop = readDesktopSettings(agentDir);
    return NextResponse.json(
      {
        cwd: projectSettingsKey(cwd),
        contextFiles: project.contextFiles ?? null,
        contextFilesEffective: project.contextFiles ?? desktop.contextFilesEnabled ?? true,
        handoff: project.handoff ?? null,
        handoffEffective: project.handoff ?? desktop.handoffEnabled ?? false,
      },
      { headers: { "x-request-id": requestId } },
    );
  } catch (error) {
    logApiError({ route: "/api/project-settings", method: "GET", requestId, error });
    return jsonError(req, 500, errorMessage(error));
  }
}

/** body: { cwd, contextFiles?, handoff? }；字段为 null 表示清除覆盖、跟随全局。 */
export async function PUT(req: Request) {
  const requestId = getRequestId(req);
  try {
    const body: unknown = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return jsonError(req, 400, "Body must be an object");
    }
    const obj = body as Record<string, unknown>;
    if (typeof obj.cwd !== "string" || !obj.cwd.trim()) {
      return jsonError(req, 400, "cwd must be a non-empty string");
    }
    const patch: ProjectSwitches = {};
    for (const key of ["contextFiles", "handoff"] as const) {
      const value = obj[key];
      if (value === undefined) continue;
      if (value !== null && typeof value !== "boolean") {
        return jsonError(req, 400, `${key} must be a boolean or null`);
      }
      patch[key] = value as boolean | null;
    }
    const agentDir = getAgentDir();
    const saved = writeProjectSetting(agentDir, obj.cwd, patch);
    const desktop = readDesktopSettings(agentDir);
    return NextResponse.json(
      {
        cwd: projectSettingsKey(obj.cwd),
        contextFiles: saved.contextFiles ?? null,
        contextFilesEffective: saved.contextFiles ?? desktop.contextFilesEnabled ?? true,
        handoff: saved.handoff ?? null,
        handoffEffective: saved.handoff ?? desktop.handoffEnabled ?? false,
      },
      { headers: { "x-request-id": requestId } },
    );
  } catch (error) {
    logApiError({ route: "/api/project-settings", method: "PUT", requestId, error });
    return jsonError(req, 500, errorMessage(error));
  }
}
