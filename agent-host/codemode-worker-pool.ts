/**
 * codemode worker 池上限：算出生效值、写回环境变量、给一行日志。
 *
 * SDK 侧的限制在 `pi-coding-agent/dist/extensions/codemode/execute.js`：整个进程最多 N 个
 * 脚本 worker（跨会话共享），超额请求按到达顺序排队、60s 拿不到就失败；槽位在 worker
 * **真正退出**后才释放（超时只是要求 VM 停止）。这里不 patch SDK，也不提前释放槽位 ——
 * 只负责把池大小调对并把它暴露到日志，剩下的卡顿用进度可见性去补。
 *
 * 优先级：设置页 > 进程环境变量 > 默认 2。SDK 每次执行脚本都重读该环境变量，
 * 所以写回后对下一条脚本立即生效，不需要重启 Host。
 */
import {
  CODEMODE_MAX_WORKERS_MAX,
  CODEMODE_MAX_WORKERS_MIN,
  isCodemodeMaxWorkers,
} from "../lib/desktop-settings.ts";

export const CODEMODE_WORKERS_ENV = "PI_CODEMODE_MAX_WORKERS";

/** 与 SDK 的 `DEFAULT_MAX_CODEMODE_WORKERS` 保持一致。 */
export const DEFAULT_CODEMODE_MAX_WORKERS = 2;

export type CodemodeWorkerPoolSource = "setting" | "env" | "default";

export interface CodemodeWorkerPool {
  value: number;
  source: CodemodeWorkerPoolSource;
}

/**
 * 环境变量按 SDK 的口径解析（任意正整数即可），设置页则受 1–8 区间约束：
 * 用户手写的环境变量不该被我们的 UI 上限悄悄砍掉。
 */
function parseEnvWorkers(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function resolveCodemodeWorkerPool(
  input: { setting?: unknown; env?: Record<string, string | undefined> } = {},
): CodemodeWorkerPool {
  if (isCodemodeMaxWorkers(input.setting)) {
    return { value: input.setting, source: "setting" };
  }
  const env = input.env ?? process.env;
  const fromEnv = parseEnvWorkers(env[CODEMODE_WORKERS_ENV]);
  if (fromEnv !== null) return { value: fromEnv, source: "env" };
  return { value: DEFAULT_CODEMODE_MAX_WORKERS, source: "default" };
}

/** 一行日志（不带 `[agent-host]` 前缀，由调用方统一加）。 */
export function formatCodemodeWorkerPoolLine(pool: CodemodeWorkerPool): string {
  return (
    `codemode worker pool = ${pool.value} (source=${pool.source}, ` +
    `hint: raise to 4 via settings or ${CODEMODE_WORKERS_ENV}; allowed ${CODEMODE_MAX_WORKERS_MIN}-${CODEMODE_MAX_WORKERS_MAX} in settings)`
  );
}

/**
 * 进程启动时的原始值：写回 env 之后它就分不清「用户设的」和「我们注入的」了，
 * 所以「跟随环境」必须一直按这个快照解析，否则设置页清空后会一直沿用旧值。
 */
const AMBIENT_WORKERS_ENV_VALUE = process.env[CODEMODE_WORKERS_ENV];

/**
 * 写回 `process.env.PI_CODEMODE_MAX_WORKERS`（SDK 每条脚本重读），返回生效值。
 * `setting: undefined | null` 表示「设置里没写 / 选了跟随环境」，此时按启动快照解析。
 */
export function applyCodemodeWorkerPool(
  input: { setting?: unknown; env?: Record<string, string | undefined> } = {},
): CodemodeWorkerPool {
  const env =
    input.env ??
    (AMBIENT_WORKERS_ENV_VALUE === undefined
      ? {}
      : { [CODEMODE_WORKERS_ENV]: AMBIENT_WORKERS_ENV_VALUE });
  const pool = resolveCodemodeWorkerPool({ setting: input.setting, env });
  process.env[CODEMODE_WORKERS_ENV] = String(pool.value);
  return pool;
}
