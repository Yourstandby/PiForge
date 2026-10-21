import { NextResponse } from "next/server";
import { existsSync, mkdirSync, statSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import { errorMessage, getRequestId, jsonError, logApiError } from "@/lib/api-error";

/**
 * POST /api/projects/create
 * body: { parentDir: string; name: string }
 *
 * 在父目录下创建一个空的项目文件夹并返回绝对路径。
 * 只允许「父目录 + 单层文件夹名」，名称里不允许出现路径分隔符或 ..，
 * 避免 UI 传参时意外写到别处。
 */
export async function POST(req: Request) {
  const requestId = getRequestId(req);
  try {
    const body = (await req.json()) as { parentDir?: unknown; name?: unknown };
    const parentDir = typeof body.parentDir === "string" ? body.parentDir.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";

    if (!parentDir || !isAbsolute(parentDir)) {
      return jsonError(req, 400, "parentDir must be an absolute path");
    }
    if (!name) {
      return jsonError(req, 400, "name is required");
    }
    if (name === "." || name === ".." || /[\\/]/.test(name)) {
      return jsonError(req, 400, "name must be a single folder name");
    }
    if (!existsSync(parentDir) || !statSync(parentDir).isDirectory()) {
      return jsonError(req, 400, "parentDir does not exist");
    }

    const target = resolve(join(parentDir, name));
    // resolve() 之后再校验一次，防止 .. 之类的相对片段逃出父目录
    if (!target.toLowerCase().startsWith(resolve(parentDir).toLowerCase())) {
      return jsonError(req, 400, "name escapes parentDir");
    }

    if (existsSync(target)) {
      return jsonError(req, 409, "Folder already exists");
    }
    mkdirSync(target, { recursive: false });

    return NextResponse.json({ path: target });
  } catch (error) {
    logApiError({ route: "/api/projects/create", method: "POST", requestId, error });
    return jsonError(req, 500, errorMessage(error));
  }
}
