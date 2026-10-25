/**
 * 拉起 node 版 agent-host 的唯一入口。
 *
 * 为什么要有工厂：host 的 stdin 控制通道靠 `PIFORGE_HOST_STDIN_CONTROL=1` **显式**开启
 * （不靠「stdin 不是 TTY」去猜，见 README 的三条硬规则）。而这些脚本一律
 * `stdio[0] = "ignore"` —— host 会把 stdin 立刻 EOF 当成「父进程死了」。父进程在
 * PiForge 自己的终端 / Host 子进程里跑度量时又会继承 `=1`，于是每个脚本都得自己记得
 * 置 0：漏一个就是静默挂死（v0.12.0 实测 `measure-prefix` / `smoke:prefix-budget`
 * 零输出卡死 120 s），手写两遍还会多出 duplicate `env:` key 把前半段 env 整块吞掉
 * （`audit-route-heap` / `measure-host-boot` 都中过）。
 *
 * 所以护栏放在这里，而不是散在调用方：`PIFORGE_HOST_STDIN_CONTROL` 在合并调用方 env
 * **之前**写死为 "0"，调用方不需要、也不该再写；确实要测 stdin 通道的用例仍可覆盖
 * （把它放进 `env` 里就会赢，因为 `...env` 在后面）。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** 仓库根（本文件位于 scripts/lib/）。 */
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** node 版 host 入口。`PIFORGE_HOST_ENTRY` 可覆盖（打包布局 / 旧产物对照）。 */
export const hostEntry = process.env.PIFORGE_HOST_ENTRY
  ? path.resolve(process.env.PIFORGE_HOST_ENTRY)
  : path.join(repoRoot, "agent-host", "dist", "agent-host", "index.js");

/**
 * spawn 一个 host 子进程。
 *
 * @param {object} [options]
 * @param {string} [options.entry] host 入口，默认 {@link hostEntry}
 * @param {string[]} [options.nodeArgs] 放在入口之前的 node 参数（如 `--expose-gc`）
 * @param {Record<string, string | undefined>} [options.env] 追加/覆盖的环境变量
 * @param {string} [options.cwd] 缺省继承父进程 cwd（与旧的裸 spawn 一致）
 * @param {Array<string | number>} [options.stdio] 缺省 `["ignore", "pipe", "pipe"]`
 * @param {boolean} [options.windowsHide] 缺省 true（别弹控制台窗口）
 */
export function hostChildEnv(env = {}) {
  return { ...process.env, PIFORGE_HOST_STDIN_CONTROL: "0", ...env };
}

export function spawnNodeHost({
  entry = hostEntry,
  nodeArgs = [],
  env = {},
  cwd,
  stdio = ["ignore", "pipe", "pipe"],
  windowsHide = true,
} = {}) {
  return spawn(process.execPath, [...nodeArgs, entry], {
    ...(cwd ? { cwd } : {}),
    stdio,
    windowsHide,
    env: hostChildEnv(env),
  });
}
