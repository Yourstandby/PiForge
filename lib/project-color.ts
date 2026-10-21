/**
 * 项目标识：路径归一化 + 稳定的柔和色。
 *
 * 关键点：**归一化只有一个实现**。左侧项目列表按 `normalizeProjectPath()` 分组，
 * 顶部标签也用它算色，所以同一个仓库（哪怕一个用 `D:\repo`、另一个用
 * `D:/repo/`）在任何位置都渲染成同一种颜色。
 *
 * 视觉上用「微胶囊」而不是纯色长条：8×8 圆角小方块 + 半透明填充 + 同色描边，
 * 既保留识别度，又不会抢走红绿灯状态指示灯的注意力。
 */

/** 柔和的品牌友好色板（饱和度刻意压低，浅底深色都可用）。 */
const PROJECT_TINTS = [
  "#2563EB", // blue
  "#3E8A63", // green
  "#B7791F", // amber
  "#7C5BD6", // violet
  "#0E7490", // teal
  "#C2554E", // clay
  "#8A6A3B", // bronze
  "#4B5563", // slate
] as const;

/**
 * 与 sidebar 分组逻辑完全一致的路径归一化：
 * 统一分隔符、去掉尾部斜杠、Windows 盘符/UNC 路径大小写不敏感、WSL 主机名小写。
 */
export function normalizeProjectPath(cwd: string | null | undefined): string {
  const raw = (cwd ?? "").trim();
  if (!raw) return "";
  const path = raw.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  const wsl = path.match(/^(\/\/(?:wsl\.localhost|wsl\$)\/[^/]+)(\/.*)?$/i);
  if (wsl) return wsl[1].toLowerCase() + (wsl[2] ?? "");
  return /^(?:[a-z]:|\/\/)/i.test(path) ? path.toLowerCase() : path;
}

/** Stable 32-bit hash so the same folder always maps to the same tint. */
function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function projectTint(cwd: string | null | undefined): string {
  const key = normalizeProjectPath(cwd);
  if (!key) return PROJECT_TINTS[PROJECT_TINTS.length - 1];
  return PROJECT_TINTS[hashString(key) % PROJECT_TINTS.length];
}

/** 微胶囊的内联样式：半透明填充 + 同色系细描边。 */
export function projectTintStyle(cwd: string | null | undefined): {
  backgroundColor: string;
  boxShadow: string;
} {
  const tint = projectTint(cwd);
  return {
    backgroundColor: `${tint}CC`, // ~80% 不透明度
    boxShadow: `inset 0 0 0 1px ${tint}40`,
  };
}
