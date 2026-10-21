/**
 * 上游 pi 核心（@earendil-works/pi-coding-agent）版本检测。
 *
 * 桌面端只是官方 SDK 的壳：核心升级 = 换 SDK 版本后重打包。
 * 这里读本地已安装版本，并向 npm registry 查询最新版，用于底栏提示。
 * 网络不可达时静默降级（只显示本地版本）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const PI_CORE_PACKAGE = "@earendil-works/pi-coding-agent";
// npmjs 常被国内网络阻断，npmmirror 兜底；两者都失败才降级为"仅本地版本"。
const REGISTRY_URLS = [
  `https://registry.npmjs.org/${encodeURIComponent(PI_CORE_PACKAGE)}/latest`,
  `https://registry.npmmirror.com/${encodeURIComponent(PI_CORE_PACKAGE)}/latest`,
];
const CACHE_TTL_MS = 30 * 60 * 1000;
/** 失败后 60 秒内不再重试，避免设置面板反复卡在超时上 */
const FAILURE_TTL_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 6000;

export interface UpstreamVersionStatus {
  /** 本地 node_modules 中安装的版本 */
  local: string;
  /** registry 上的最新版本；查询失败为 null */
  latest: string | null;
  hasUpdate: boolean;
  checkedAt: number;
  error?: string;
}

interface CacheState {
  status: UpstreamVersionStatus | null;
  at: number;
}

const globalCache = globalThis as typeof globalThis & {
  __piforgeUpstreamVersionCache?: CacheState;
};
if (!globalCache.__piforgeUpstreamVersionCache) {
  globalCache.__piforgeUpstreamVersionCache = { status: null, at: 0 };
}

export function readLocalPiVersion(projectRoot = process.cwd()): string {
  try {
    const pkgPath = join(projectRoot, "node_modules", ...PI_CORE_PACKAGE.split("/"), "package.json");
    const raw = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return raw.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** 语义化版本比较：a > b 返回正数。忽略预发布标签以外的差异，够用于 x.y.z。 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => value.split("-")[0].split(".").map((part) => Number(part) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function fetchLatestVersion(): Promise<string | null> {
  for (const url of REGISTRY_URLS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      if (!response.ok) continue;
      const body = (await response.json()) as { version?: string };
      if (typeof body.version === "string") return body.version;
    } catch {
      // 换下一个源
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

export async function getUpstreamVersionStatus(force = false): Promise<UpstreamVersionStatus> {
  const cache = globalCache.__piforgeUpstreamVersionCache!;
  const now = Date.now();
  if (!force && cache.status) {
    const ttl = cache.status.latest ? CACHE_TTL_MS : FAILURE_TTL_MS;
    if (now - cache.at < ttl) return cache.status;
  }

  const local = readLocalPiVersion();
  // 查询失败时保留上次成功拿到的版本，不要用 null 覆盖（否则面板会误报"无法连接"）
  const latest = (await fetchLatestVersion()) ?? cache.status?.latest ?? null;
  const status: UpstreamVersionStatus = {
    local,
    latest,
    hasUpdate: Boolean(latest && local !== "unknown" && compareVersions(latest, local) > 0),
    checkedAt: now,
    ...(latest ? {} : { error: "registry unreachable" }),
  };
  cache.status = status;
  cache.at = now;
  return status;
}
