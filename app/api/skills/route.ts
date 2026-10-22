import { NextResponse } from "next/server";
import { homedir } from "os";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { DefaultResourceLoader, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { errorMessage, getRequestId, jsonError, logApiError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

interface SkillSourceInfo {
  source?: string;
  scope?: string;
  path?: string;
  baseDir?: string;
}

interface RawSkill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation: boolean;
  sourceInfo?: SkillSourceInfo;
}

interface SkillDto extends RawSkill {
  scope: "global" | "project";
  origin: "agents" | "pi" | "package" | "other";
}

/**
 * pi 用 `process.env.HOME` 拼「用户级技能」路径。Git Bash / msys2 启动时 HOME 是
 * `/c/Users/x` 这种 POSIX 形式，Windows 上拼出来的目录根本不存在，于是
 * `~/.agents/skills` 全丢（面板显示「未找到技能」）。调用期间对齐到真实家目录。
 */
let homeLock: Promise<unknown> = Promise.resolve();

function withRealHome<T>(run: () => Promise<T>): Promise<T> {
  const task = homeLock.then(async () => {
    const previous = process.env.HOME;
    const real = homedir();
    try {
      if (previous !== real) process.env.HOME = real;
      return await run();
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
    }
  });
  homeLock = task.catch(() => {});
  return task;
}

function describeSource(skill: RawSkill): { scope: "global" | "project"; origin: SkillDto["origin"] } {
  const info = skill.sourceInfo ?? {};
  const scope = info.scope === "project" ? "project" : "global";
  const baseDir = (info.baseDir ?? skill.baseDir ?? "").toLowerCase();
  if (/[\\/]\.agents([\\/]|$)/.test(baseDir)) return { scope, origin: "agents" };
  if (/[\\/]\.pi([\\/]|$)/.test(baseDir)) return { scope, origin: "pi" };
  if (info.source === "package" || info.source === "npm") return { scope, origin: "package" };
  return { scope, origin: "other" };
}

/** 面板每次打开都会触发一次扫描（含 package resolve）；5s 内复用结果避免卡顿。 */
const CACHE_TTL_MS = 5_000;
const cache = new Map<string, { at: number; skills: SkillDto[]; diagnostics: unknown[] }>();

// GET /api/skills?cwd=<path>
// Uses DefaultResourceLoader (same logic as AgentSession startup) so settings.json
// skill paths, package skills, and .agents/skills directories are all included.
export async function GET(req: Request) {
  const requestId = getRequestId(req);
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  if (!cwd) return jsonError(req, 400, "cwd required");
  // 安装/删除技能后前端带 refresh=1 跳过缓存，保证立即看到新技能。
  const refresh = searchParams.get("refresh") === "1";

  const cached = cache.get(cwd);
  if (!refresh && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return NextResponse.json({ skills: cached.skills, diagnostics: cached.diagnostics });
  }

  try {
    const payload = await withRealHome(async () => {
      const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir() });
      await loader.reload();
      const { skills, diagnostics } = loader.getSkills();
      const mapped: SkillDto[] = (skills as RawSkill[]).map((skill) => ({
        ...skill,
        ...describeSource(skill),
      }));
      return { skills: mapped, diagnostics: diagnostics as unknown[] };
    });
    cache.set(cwd, { at: Date.now(), ...payload });
    return NextResponse.json(payload);
  } catch (error) {
    logApiError({ route: "/api/skills", method: "GET", requestId, error, params: { cwd } });
    return jsonError(req, 500, errorMessage(error));
  }
}

// PATCH /api/skills — toggle disable-model-invocation on a SKILL.md file
export async function PATCH(req: Request) {
  const requestId = getRequestId(req);
  try {
    const body = await req.json() as { filePath: string; disableModelInvocation: boolean };
    const { filePath, disableModelInvocation } = body;
    if (!filePath) return jsonError(req, 400, "filePath required");
    if (!existsSync(filePath)) return jsonError(req, 404, "file not found");

    const content = readFileSync(filePath, "utf8");
    const key = "disable-model-invocation";

    // Use parseFrontmatter to check current value, then do a surgical line edit
    // to preserve the original YAML formatting of all other fields.
    const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
    const alreadySet = Boolean(frontmatter[key]);

    let updated = content;
    if (disableModelInvocation && !alreadySet) {
      // Add key after the opening --- line
      updated = content.replace(/^---\r?\n/, `---\n${key}: true\n`);
      // If no frontmatter exists, create one
      if (updated === content) updated = `---\n${key}: true\n---\n${content}`;
    } else if (!disableModelInvocation && alreadySet) {
      // Remove the key line entirely
      updated = content.replace(new RegExp(`^${key}\\s*:.*\\r?\\n`, "m"), "");
    }

    writeFileSync(filePath, updated, "utf8");
    cache.clear();
    return NextResponse.json({ success: true });
  } catch (error) {
    logApiError({ route: "/api/skills", method: "PATCH", requestId, error });
    return jsonError(req, 500, errorMessage(error));
  }
}
