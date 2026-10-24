/**
 * 受管进程的环境变量清理（L1 传输层立项的风险 #3）。
 *
 * 问题：host 改用 `ELECTRON_RUN_AS_NODE=1` 启动后，agent-host 自己拉起的
 * **每个**受管进程（dev server、pwsh、用户命令…）都会继承这个变量 ——
 * 之后任何以 `electron.exe` / `PiForge.exe` 开头的命令都会静默变成"跑 node"，
 * 表现为"应用启动不起来、没有任何窗口"。这类故障极难从日志看出。
 *
 * 处理：host 侧 spawn 之前统一过一遍 `stripElectronRunAsNode()`；主进程侧
 * `electron/env-filter.ts` 本来就有同样的黑名单（双保险）。
 *
 * 纯函数，不 import 任何 Electron / SDK，便于单测。
 */

const DENY = new Set(["ELECTRON_RUN_AS_NODE", "ELECTRON_RUN_AS_NODE_ENABLED"]);

/** 去掉 Electron-as-Node 控制变量，其余原样保留（不做白名单，避免丢 SystemRoot 之类）。 */
export function stripElectronRunAsNode(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (DENY.has(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * 受管进程的最终环境：干净继承 + 固定项（颜色关闭，避免 ANSI 污染日志）。
 * `extra` 用于 PowerShell 之类需要额外变量的场景，最后合并（可覆盖）。
 */
export function managedProcessEnv(
  base: Record<string, string | undefined>,
  extra: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(stripElectronRunAsNode(base))) {
    if (value !== undefined) out[key] = value;
  }
  out.FORCE_COLOR = "0";
  out.NO_COLOR = "1";
  return { ...out, ...extra };
}
