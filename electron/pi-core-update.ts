/**
 * pi 核心版本切换（Main 侧执行）。
 *
 * 核心版本是构建期依赖（`agent-host/sdk-adapter.ts` 静态 import），运行期换不了，
 * 所以「升级 / 降级」= 把目标版本装进当前生效的 node_modules，然后重启应用。
 *
 * 打包版用户机器上通常没有 Node/npm，因此主路径**不依赖 npm**：
 *   1. 从 npm registry 直接下 tarball（fetch + zlib 解 gzip + 自带 tar 解析）；
 *   2. 解到 node_modules 里的临时目录，校验版本后再原子替换；
 *   3. 只在网络失败且本机确实有 npm 时兜底走 npm（能吃到用户 .npmrc 代理）。
 *
 * electron/ 用 tsc 单独编译（rootDir=.），不能回引 lib/，版本校验在此保留一份。
 */

import { spawn } from "child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import path from "path";
import { gunzipSync } from "zlib";

export const PI_CORE_PACKAGE = "@earendil-works/pi-coding-agent";
/** 完整安装包下载页：装不起来时给用户的兜底出口。 */
export const PI_CORE_RELEASE_URL = "https://github.com/Yourstandby/PiForge/releases/latest";

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function isValidPiCoreVersion(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && VERSION_RE.test(value);
}

export interface PiCoreTarget {
  dir: string;
  mode: "repo" | "standalone";
}

/** 失败归类：UI 据此决定给「重试」还是「去下载完整安装包」。 */
export type PiCoreFailure =
  | "version"
  | "readonly"
  | "npm-missing"
  | "network"
  | "extract"
  | "verify"
  | "timeout"
  | "unknown";

export interface PiCoreInstallResult {
  ok: boolean;
  version: string;
  installed: string | null;
  restartRequired: boolean;
  /** 装成功用的通道 */
  via?: "tarball" | "npm";
  failure?: PiCoreFailure;
  error?: string;
  /** npm 输出尾部，失败时给用户看 */
  log?: string;
  /** 完整安装包下载页（失败时 UI 直接给链接） */
  releaseUrl: string;
}

const LOG_TAIL_LIMIT = 4000;
const NPM_TIMEOUT_MS = 180_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

export function resolvePiCoreTarget(options: {
  isPackaged: boolean;
  appPath: string;
  resourcesPath: string;
}): PiCoreTarget {
  if (options.isPackaged) {
    return { dir: path.join(options.resourcesPath, "standalone"), mode: "standalone" };
  }
  return { dir: options.appPath, mode: "repo" };
}

// ---------------------------------------------------------------------------
// 目录 / 版本探测
// ---------------------------------------------------------------------------

/** 目录是否可写（只读安装目录在 Program Files 场景下很常见）。 */
export function isDirectoryWritable(dir: string): boolean {
  const probe = path.join(dir, `.piforge-write-test-${process.pid}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(probe, "1");
    return true;
  } catch {
    return false;
  } finally {
    try {
      rmSync(probe, { force: true });
    } catch {
      /* 忽略 */
    }
  }
}

function packageDirOf(dir: string): string {
  return path.join(dir, "node_modules", ...PI_CORE_PACKAGE.split("/"));
}

/** 读某个 node_modules 里 pi 核心的实际版本；读不到返回 null。 */
export function readInstalledPiCoreVersion(dir: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(packageDirOf(dir), "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof raw.version === "string" ? raw.version : null;
  } catch {
    return null;
  }
}

/** repo 模式下把 package.json 的依赖版本对齐（打包版没有受管理的 package.json）。 */
function syncRepoPackageJson(dir: string, version: string): void {
  const pkgPath = path.join(dir, "package.json");
  try {
    const raw = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
    const deps = raw.dependencies as Record<string, string> | undefined;
    if (!deps || !(PI_CORE_PACKAGE in deps)) return;
    deps[PI_CORE_PACKAGE] = version;
    writeFileSync(pkgPath, `${JSON.stringify(raw, null, 2)}\n`);
  } catch {
    // 对齐失败不影响主流程
  }
}

// ---------------------------------------------------------------------------
// tarball 通道（不依赖 npm）
// ---------------------------------------------------------------------------

export function piCoreTarballUrls(version: string): string[] {
  const name = PI_CORE_PACKAGE.split("/")[1];
  const file = `${name}-${version}.tgz`;
  return [
    `https://registry.npmjs.org/${PI_CORE_PACKAGE.replace("/", "%2F")}/-/${file}`,
    `https://registry.npmmirror.com/${PI_CORE_PACKAGE}/-/${file}`,
  ];
}

interface TarEntry {
  name: string;
  body: Buffer;
}

/** 最小 tar 解析：ustar + prefix + GNU longname，足够解 npm tarball。 */
export function parseTar(buffer: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let longName: string | null = null;

  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    // 全零块 = 归档结束
    if (header.every((byte) => byte === 0)) break;

    const rawName = readString(header, 0, 100);
    const size = parseInt(readString(header, 124, 12).trim() || "0", 8);
    const typeflag = String.fromCharCode(header[156] ?? 0);
    const prefix = readString(header, 345, 155);
    const body = buffer.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;

    if (typeflag === "L") {
      longName = readString(body, 0, body.length);
      continue;
    }
    // pax 元数据块不落盘
    if (typeflag === "x" || typeflag === "g") continue;

    const name = longName ?? (prefix ? `${prefix}/${rawName}` : rawName);
    longName = null;
    if (!name || typeflag === "5") continue;
    entries.push({ name, body: Buffer.from(body) });
  }
  return entries;
}

function readString(buffer: Buffer, start: number, length: number): string {
  const slice = buffer.subarray(start, start + length);
  const end = slice.indexOf(0);
  return (end === -1 ? slice : slice.subarray(0, end)).toString("utf8");
}

/** 解包到目标 node_modules 目录：先落临时目录，校验后替换，失败可回滚。 */
export function extractPiCoreTarball(gz: Buffer, targetDir: string, expectedVersion: string): void {
  const entries = parseTar(gunzipSync(gz));
  if (entries.length === 0) throw new Error("tarball 为空");

  const parent = path.join(targetDir, "node_modules", ...PI_CORE_PACKAGE.split("/").slice(0, 1));
  mkdirSync(parent, { recursive: true });
  const staging = path.join(parent, `.pi-core-staging-${process.pid}`);
  const finalDir = packageDirOf(targetDir);
  const backup = `${finalDir}.bak-${process.pid}`;

  rmSync(staging, { recursive: true, force: true });
  try {
    for (const entry of entries) {
      const rel = entry.name.replace(/^package\//, "");
      if (!rel || rel.startsWith("/") || rel.split("/").includes("..")) continue;
      const dest = path.join(staging, rel);
      if (!dest.startsWith(staging)) continue;
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, entry.body);
    }

    const staged = JSON.parse(readFileSync(path.join(staging, "package.json"), "utf8")) as {
      version?: unknown;
    };
    if (staged.version !== expectedVersion) {
      throw new Error(`tarball 版本不符：期望 ${expectedVersion}，实际 ${String(staged.version)}`);
    }

    rmSync(backup, { recursive: true, force: true });
    if (existsSync(finalDir)) renameSync(finalDir, backup);
    try {
      renameSync(staging, finalDir);
    } catch (error) {
      if (existsSync(backup)) renameSync(backup, finalDir);
      throw error;
    }
    rmSync(backup, { recursive: true, force: true });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function downloadTarball(
  version: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<Buffer> {
  let lastError = "no registry reachable";
  for (const url of piCoreTarballUrls(version)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { signal: controller.signal, redirect: "follow" });
      if (!response.ok) {
        lastError = `${url} → HTTP ${response.status}`;
        continue;
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = `${url} → ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(lastError);
}

// ---------------------------------------------------------------------------
// npm 通道（兜底）
// ---------------------------------------------------------------------------

/** npm 参数只由校验过的版本号 + 固定 flag 组成，不接受任意 spec。 */
export function buildNpmInstallArgs(version: string, target: PiCoreTarget): string[] {
  if (!isValidPiCoreVersion(version)) throw new Error(`invalid version: ${version}`);
  return [
    "install",
    `${PI_CORE_PACKAGE}@${version}`,
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
    target.mode === "repo" ? "--save-exact" : "--no-save",
  ];
}

function appendLog(buffer: string, chunk: string): string {
  const next = buffer + chunk;
  return next.length > LOG_TAIL_LIMIT ? next.slice(next.length - LOG_TAIL_LIMIT) : next;
}

interface NpmOutcome {
  ok: boolean;
  error?: string;
  failure: PiCoreFailure;
  log: string;
}

function runNpmInstall(
  version: string,
  target: PiCoreTarget,
  options: { onLog?: (chunk: string) => void; timeoutMs: number; spawnImpl: typeof spawn; env?: NodeJS.ProcessEnv },
): Promise<NpmOutcome> {
  return new Promise<NpmOutcome>((resolve) => {
    let log = "";
    let settled = false;
    const timer: { id?: NodeJS.Timeout } = {};
    const finish = (outcome: NpmOutcome) => {
      if (settled) return;
      settled = true;
      if (timer.id) clearTimeout(timer.id);
      resolve(outcome);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = options.spawnImpl(process.platform === "win32" ? "npm.cmd" : "npm", buildNpmInstallArgs(version, target), {
        cwd: target.dir,
        // Windows 下 npm 是 .cmd，必须过 shell；参数只有校验过的版本号，无注入面。
        shell: process.platform === "win32",
        windowsHide: true,
        env: options.env ?? process.env,
      });
    } catch (error) {
      finish({ ok: false, failure: "npm-missing", error: error instanceof Error ? error.message : String(error), log });
      return;
    }

    timer.id = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
      finish({ ok: false, failure: "timeout", error: `npm 超时（${Math.round(options.timeoutMs / 1000)}s）`, log });
    }, options.timeoutMs);

    const onChunk = (chunk: Buffer) => {
      const text = chunk.toString();
      log = appendLog(log, text);
      options.onLog?.(text);
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    // ENOENT：找不到 npm（Linux/macOS 直连 spawn 时才会走到这里）
    child.on("error", (error) => {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      finish({
        ok: false,
        failure: missing ? "npm-missing" : "unknown",
        error: missing ? "未找到 npm（本机没有 Node.js）" : `无法执行 npm：${error.message}`,
        log,
      });
    });
    child.on("close", (code) => {
      if (code === 0) {
        finish({ ok: true, failure: "unknown", log });
        return;
      }
      // Windows + shell 下 npm 缺失表现为 cmd 的非零退出，别报成"退出码 1"了事
      const missing = /not recognized|不是内部或外部命令|command not found|ENOENT/i.test(log);
      finish({
        ok: false,
        failure: missing ? "npm-missing" : "unknown",
        error: missing ? "未找到 npm（本机没有 Node.js）" : `npm 退出码 ${code}`,
        log,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

export interface InstallPiCoreOptions {
  version: string;
  target: PiCoreTarget;
  /** 流式输出（在 UI 显示进度文案） */
  onLog?: (chunk: string) => void;
  timeoutMs?: number;
  spawnImpl?: typeof spawn;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  /** 允许 npm 兜底（默认 true；测试可关掉以保证离线确定） */
  allowNpmFallback?: boolean;
}

export async function installPiCoreVersion(options: InstallPiCoreOptions): Promise<PiCoreInstallResult> {
  const { version, target } = options;
  const base: PiCoreInstallResult = {
    ok: false,
    version,
    installed: readInstalledPiCoreVersion(target.dir),
    restartRequired: true,
    releaseUrl: PI_CORE_RELEASE_URL,
  };

  if (!isValidPiCoreVersion(version)) {
    return { ...base, failure: "version", error: `版本号不合法：${version}` };
  }
  if (!isDirectoryWritable(target.dir)) {
    return {
      ...base,
      failure: "readonly",
      error: `安装目录不可写（${target.dir}），请把应用装到用户目录，或下载完整安装包覆盖升级`,
    };
  }

  // 1) tarball 通道：不依赖 npm，绝大多数情况走这条
  let tarballError: string | null = null;
  try {
    options.onLog?.(`下载 ${PI_CORE_PACKAGE}@${version} …`);
    const gz = await downloadTarball(
      version,
      options.fetchImpl ?? fetch,
      Math.min(options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS, DOWNLOAD_TIMEOUT_MS),
    );
    options.onLog?.("下载完成，正在解包 …");
    extractPiCoreTarball(gz, target.dir, version);
    const installed = readInstalledPiCoreVersion(target.dir);
    if (installed !== version) {
      return {
        ...base,
        installed,
        failure: "verify",
        error: `解包后版本仍为 ${installed ?? "unknown"}，可能被旧文件占用`,
      };
    }
    if (target.mode === "repo") syncRepoPackageJson(target.dir, version);
    return { ...base, ok: true, installed, via: "tarball" };
  } catch (error) {
    tarballError = error instanceof Error ? error.message : String(error);
    options.onLog?.(`tarball 通道失败：${tarballError}`);
  }

  // 2) npm 兜底：网络受限但本机有 npm（可吃 .npmrc 代理）
  if (options.allowNpmFallback !== false) {
    const npm = await runNpmInstall(version, target, {
      onLog: options.onLog,
      timeoutMs: options.timeoutMs ?? NPM_TIMEOUT_MS,
      spawnImpl: options.spawnImpl ?? spawn,
      env: options.env,
    });
    const installed = readInstalledPiCoreVersion(target.dir);
    if (npm.ok && installed === version) {
      if (target.mode === "repo") syncRepoPackageJson(target.dir, version);
      return { ...base, ok: true, installed, via: "npm", log: npm.log };
    }
    if (npm.failure === "npm-missing") {
      return {
        ...base,
        installed,
        failure: "npm-missing",
        error: `下载失败（${tarballError}），且本机没有 npm。请下载完整安装包覆盖升级。`,
        log: npm.log,
      };
    }
    return {
      ...base,
      installed,
      failure: npm.failure === "timeout" ? "timeout" : "network",
      error: `下载失败（${tarballError}）${npm.error ? `；npm 兜底也失败：${npm.error}` : ""}`,
      log: npm.log,
    };
  }

  return {
    ...base,
    failure: "network",
    error: `下载失败：${tarballError}`,
  };
}

/** 兼容旧调用：探测 node_modules 是否完整（打包 smoke 用）。 */
export function isPiCoreInstalled(dir: string): boolean {
  try {
    return statSync(path.join(packageDirOf(dir), "package.json")).isFile();
  } catch {
    return false;
  }
}
