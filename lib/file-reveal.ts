import { getRelativeFilePath, joinFilePath, normalizeFilePathSlashes } from "./file-paths.ts";

export interface FileRevealChain {
  /** 需要展开的祖先目录（项目根往下，不含文件本身）。 */
  ancestors: string[];
  /** 目标文件的绝对路径（"/" 分隔）；不在项目内时为 null。 */
  target: string | null;
}

/**
 * 把「聊天里点到的文件」换算成文件树需要展开的目录链。
 * 纯函数：不碰 DOM，Windows 反斜杠 / 大小写由 normalizeFilePathSlashes 归一。
 */
export function computeRevealChain(cwd: string, filePath: string): FileRevealChain {
  const normalizedCwd = normalizeFilePathSlashes(cwd).replace(/\/+$/, "");
  const normalizedFile = normalizeFilePathSlashes(filePath);
  if (!normalizedCwd || !normalizedFile) return { ancestors: [], target: null };

  const relative = getRelativeFilePath(normalizedFile, normalizedCwd);
  // 不在当前项目内（其它项目 / 用户目录 / 绝对路径原样返回）：树里没有这个节点。
  if (relative === normalizedFile || relative.startsWith("../") || relative === "..") {
    return { ancestors: [], target: null };
  }

  const segments = relative.split("/").filter(Boolean);
  if (segments.length === 0) return { ancestors: [], target: null };

  const ancestors: string[] = [];
  let current = normalizedCwd;
  for (let i = 0; i < segments.length; i += 1) {
    current = joinFilePath(current, segments[i]);
    if (i < segments.length - 1) ancestors.push(current);
  }
  return { ancestors, target: current };
}
