/**
 * Environment for the app's own child processes (Next server + Agent Host).
 *
 * 这里曾经是「白名单」：只放行几个 API key 和 `PI_*`。结果把
 * `SystemRoot` / `windir` / `ComSpec` / `APPDATA` 这些 Windows 必需变量一起
 * 过滤掉了 —— 宿主进程里 `ws` 的 `server.listen(0, "127.0.0.1")` 会直接抛
 * `listen UNKNOWN: unknown error 127.0.0.1`（libuv 收到未映射的 Winsock 错误），
 * Agent Host 连续重启 5 次后放弃，`/api/health` 变成 offline，输入框被
 * `disabled` 卡死、发送按钮永远是灰的。
 *
 * 现在改为「全量继承 + 极小黑名单」：
 * - Next / Host 都是本应用自己的子进程，继承完整环境才是常规做法；
 * - 用户自定义的代理（HTTPS_PROXY）、自定义 CA、PATH 扩充也能正常生效；
 * - 只剔除会改变子进程语义的控制变量，它们由主进程显式注入。
 */
const ENV_DENYLIST = new Set([
  // 让 Electron 二进制以 Node 模式运行的开关，绝不能让子进程误继承
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_RUN_AS_NODE_ENABLED",
  // 由主进程按实例注入（endpoint/token 必须配对，继承旧值会连错管道）
  "PIFORGE_AGENT_ENDPOINT",
  "PIFORGE_AGENT_TOKEN",
  // 只在「没有 parentPort、用 stdin 当控制通道」的探针/host 里成立。
  // 泄漏给用户 shell 或冒烟脚本后，`stdio: ["ignore"]` 的 host 会把 stdin EOF
  // 当成「父进程死了」直接退出（表现为冒烟 `timed out waiting for a frame`）。
  "PIFORGE_HOST_STDIN_CONTROL",
]);

export function childProcessEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (ENV_DENYLIST.has(key)) continue;
    out[key] = value;
  }
  return out;
}

/** @deprecated 旧名字；行为已改为「全量继承 + 黑名单」，请用 childProcessEnv。 */
export const pickApiKeys = childProcessEnv;
