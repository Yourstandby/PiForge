/**
 * 上游 pi 核心（@earendil-works/pi-coding-agent）版本检测。
 *
 * 桌面端只是官方 SDK 的壳：核心升级 = 换 SDK 版本后重打包。
 * 这里读本地已安装版本，并向 npm registry 查询最新版，用于底栏提示。
 * 网络不可达时静默降级（只显示本地版本）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compareVersions, isPrerelease, sortVersionsDesc } from "./version-compare.ts";

export { compareVersions } from "./version-compare.ts";

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

/** 版本列表缓存：与 latest 检查分开，选版本面板才需要全量列表。 */
interface VersionListState {
  list: PiCoreVersionList | null;
  at: number;
}

const listCache = globalThis as typeof globalThis & {
  __piforgePiCoreVersionListCache?: VersionListState;
};
if (!listCache.__piforgePiCoreVersionListCache) {
  listCache.__piforgePiCoreVersionListCache = { list: null, at: 0 };
}

/** 可切换的版本上限：registry 上该包数百个版本，面板只需要最近的一批。 */
const MAX_VERSIONS = 80;

/** 全部可切换版本（含预发布），供升级/降级选择器使用。 */
export interface PiCoreVersionList {
  local: string;
  latest: string | null;
  /** 语义化降序，正式版与预发布混排（预发布由 UI 过滤） */
  versions: string[];
  /** 本地是否与 latest 相同 */
  upToDate: boolean;
  checkedAt: number;
  error?: string;
}

async function fetchVersionList(): Promise<string[] | null> {
  for (const url of REGISTRY_URLS.map((latest) => latest.replace(/\/latest$/, ""))) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      // abbreviated packument：只取版本清单，别把整份 metadata 拉下来。
      const response = await fetch(url, {
        signal: controller.signal,
        cache: "no-store",
        headers: { accept: "application/vnd.npm.install-v1+json" },
      });
      if (!response.ok) continue;
      const body = (await response.json()) as { versions?: Record<string, unknown> };
      const versions = body.versions ? Object.keys(body.versions) : [];
      if (versions.length > 0) return versions;
    } catch {
      // 换下一个源
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

export async function getPiCoreVersionList(force = false): Promise<PiCoreVersionList> {
  const cache = listCache.__piforgePiCoreVersionListCache!;
  const now = Date.now();
  if (!force && cache.list) {
    const ttl = cache.list.versions.length > 0 ? CACHE_TTL_MS : FAILURE_TTL_MS;
    if (now - cache.at < ttl) return cache.list;
  }

  const local = readLocalPiVersion();
  const fetched = await fetchVersionList();
  // 拉不到就保留上一次的清单，别让面板变空。
  const raw = fetched ?? cache.list?.versions ?? [];
  const sorted = sortVersionsDesc(raw).slice(0, MAX_VERSIONS);
  const latest = cache.list?.latest ?? null;
  const list: PiCoreVersionList = {
    local,
    latest: fetched ? sorted.find((version) => !isPrerelease(version)) ?? latest : latest,
    versions: sorted,
    upToDate: Boolean(latest && local !== "unknown" && local === latest),
    checkedAt: now,
    ...(fetched ? {} : { error: "registry unreachable" }),
  };
  cache.list = list;
  cache.at = now;
  return list;
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
