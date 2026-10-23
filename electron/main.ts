import { app, BrowserWindow, dialog, ipcMain, nativeImage, protocol, session, shell, utilityProcess, WebContentsView, webContents } from "electron";
import type { UpdateInfo } from "electron-updater";
import path from "path";
import v8 from "node:v8";
import { randomBytes } from "crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { spawn, spawnSync } from "child_process";
import net from "net";
import { createTray } from "./tray";
import { waitForNextServerReady } from "./server-wait";
import { killProcessDescendants, killProcessTree } from "./process-tree";
import { childProcessEnv } from "./env-filter";
import { choosePort } from "./port-selection";
import { getNextRestartState, type ServerState } from "./restart-policy";
import { getNextCrashReloadState } from "./crash-recovery";
import { loadPageWithRetry } from "./navigation";
import { formatElectronLogLine, deriveScope, type ElectronLogLevel } from "./log-format";
import {
  createUpdateInstallState,
  decideQuitAndInstall,
  markUpdateDownloaded,
  type UpdateInstallState,
} from "./update-install-gate";
import { buildElectronCspHeader, buildStaticAppCspHeader } from "./csp";
import { AgentHostApiBridge } from "./api-bridge";
import {
  createStaticAppHandler,
  STATIC_APP_ORIGIN,
  STATIC_APP_SCHEME,
} from "./static-app";
import { isHeapExhaustion, resolveHostHeapFlags } from "./host-heap";
import {
  describeReEvaluation,
  GPU_EVIDENCE_FILE,
  parseGpuEvidence,
  recordGpuObservation,
  resolveGpuMode,
  type GpuEvidence,
} from "./gpu-preference";
import { getAppIconPath } from "./app-icon";
import { applyTitleBarOverlayTheme, titleBarOverlayOptions } from "./title-bar-overlay";
import { normalizeWindowPath } from "./window-path";
import {
  ServerProcess,
  wrapChildServerProcess,
  wrapUtilityServerProcess,
} from "./server-process";
import { BrowserManager } from "./browser-manager";
import { BrowserHostBridge } from "./browser-host-bridge";
import { installPiCoreVersion, resolvePiCoreTarget } from "./pi-core-update";
import {
  AGENT_HOST_HARD_TIMEOUT_MS,
  AGENT_HOST_READY_TIMEOUT_MS,
  type AgentHostState,
  describeHostState,
  initialHostReadiness,
  markHostBooting,
  markHostReady,
  markHostStopped,
  onHardTimeout,
  onSoftTimeout,
} from "./host-readiness";

// Packaged browser smoke runs Electron without a visible window; software
// rendering avoids capturePage's UnknownVizError on headless CI.
if (process.env.SMOKE_BROWSER === "1") {
  app.disableHardwareAcceleration();
}

/**
 * 隔离 userData（`PIFORGE_USER_DATA`）。
 *
 * 用途：`npm run measure:packaged` 要在**不影响正在使用的实例**的前提下起一个
 * 干净的 PiForge 采内存/启动数据。单实例锁是跟着 userData 走的，所以必须在
 * `requestSingleInstanceLock()` 之前改路径。
 */
/**
 * 隔离 userData（`PIFORGE_USER_DATA`）。
 *
 * 必须在最前面：单实例锁与「GPU 证据文件」都跟着 userData 走。
 * 用途：`measure-packaged` 在不影响正在使用的实例的前提下起干净实例采样。
 */
const userDataOverride = process.env.PIFORGE_USER_DATA?.trim();
if (userDataOverride) {
  app.setPath("userData", path.resolve(userDataOverride));
}

/**
 * GPU/版本取证（B 项需要跨机器对齐时的事实来源）。
 *
 * 记录三样东西，全部来自运行中的进程：
 *   1. `process.versions`（Electron / Chromium / Node / V8）；
 *   2. `app.getGPUFeatureStatus()`（硬件加速到底有没有生效、哪些特性被 blocklist）；
 *   3. 与合成相关的 Chromium switch（GPU 进程的 RSS 主要由它们决定）。
 *
 * 分析 gpu 进程内存时如果只有 RSS 没有这三样，等于没法判断"版本差"还是"基线"。
 */
const GPU_SWITCH_PREFIXES = ["--disable-gpu", "--use-gl", "--use-angle", "--enable-features", "--disable-features", "--enable-gpu", "--force-device-scale-factor", "--in-process-gpu"];

function gpuSwitchesFrom(argv: string[]): string[] {
  return argv.filter((arg) => GPU_SWITCH_PREFIXES.some((prefix) => arg.startsWith(prefix)));
}

/**
 * 自适应 GPU 策略（见 electron/gpu-preference.ts 的推理与实测数据）。
 *
 * 读上一轮落盘的 `gpu-evidence.json`：连续 2 次观察到"软件合成"才在本轮
 * 加 `--disable-gpu`（省 ~100 MB gpu 进程，实测 254.7 → 155.7 MB）。
 * 硬件加速可用的机器永远不会被切（证据里是 `enabled`）。
 */
function readGpuEvidence(): GpuEvidence | null {
  try {
    const file = path.join(app.getPath("userData"), GPU_EVIDENCE_FILE);
    return parseGpuEvidence(existsSync(file) ? readFileSync(file, "utf8") : null);
  } catch {
    return null;
  }
}

const gpuEvidenceAtBoot = readGpuEvidence();
const gpuDecision = resolveGpuMode({ evidence: gpuEvidenceAtBoot, env: process.env });
for (const name of gpuDecision.switches) app.commandLine.appendSwitch(name);

/**
 * 决策轨迹：只在**模式或依据变化**时输出一行
 * `gpu mode re-evaluated: <prev>→<next>, reason=<code>`。
 *
 * 注意这里只计算不写日志 —— `app.getPath("logs")` 在 `ready` 之前取不到（Windows），
 * 提前写会被 writeLog 的 try/catch 静默吞掉（本机踩过）。真正的落盘在 ready 之后。
 */
const gpuReEvaluation = describeReEvaluation(gpuEvidenceAtBoot?.decision ?? null, gpuDecision);

/**
 * 实验用 GPU 开关：`PIFORGE_GPU_FLAGS="--disable-gpu-compositing,--use-angle=d3d11"`。
 * 只在 `app.ready` 之前生效，且**不改变默认行为**（不设就是 Chromium 默认）。
 */
const gpuFlagsEnv = process.env.PIFORGE_GPU_FLAGS?.trim();
if (gpuFlagsEnv) {
  for (const flag of gpuFlagsEnv.split(",").map((entry) => entry.trim()).filter(Boolean)) {
    const [name, value] = flag.split("=");
    if (value === undefined) app.commandLine.appendSwitch(name.replace(/^--/, ""));
    else app.commandLine.appendSwitch(name.replace(/^--/, ""), value);
  }
}

/** 实验用：`PIFORGE_DISABLE_HW_ACCEL=1` 走软件合成（等价于关硬件加速）。 */
if (process.env.PIFORGE_DISABLE_HW_ACCEL === "1") {
  app.disableHardwareAcceleration();
}


// ---------------------------------------------------------------------------
// Single Instance Lock
// ---------------------------------------------------------------------------
// 自定义协议必须在 ready 之前声明：`standard` 让它有同源语义（fetch/相对路径可用），
// `supportFetchAPI` + `stream` 让 `/api/**` 的 SSE 与二进制下载走同一条路。
protocol.registerSchemesAsPrivileged([
  {
    scheme: STATIC_APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false },
  },
]);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

app.on("second-instance", () => {
  const target =
    lastFocusedWindow && !lastFocusedWindow.isDestroyed()
      ? lastFocusedWindow
      : mainWindow && !mainWindow.isDestroyed()
        ? mainWindow
        : null;
  if (target) {
    if (target.isMinimized()) target.restore();
    target.show();
    target.focus();
  } else if (startupUiReady) {
    openNewWindow();
  }
});

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let mainWindow: BrowserWindow | null = null;
let lastFocusedWindow: BrowserWindow | null = null;
const appWindows = new Set<BrowserWindow>();
const windowPaths = new WeakMap<BrowserWindow, string>();
let sessionCspInstalled = false;
/**
 * P1-4：默认**不再启动 Next standalone**，渲染进程加载 `piforge://app/`，
 * `/api/**` 经命名管道交给 Agent Host。`PIFORGE_USE_NEXT=1` 保留旧路径做回退。
 */
const USE_NEXT_SERVER = process.env.PIFORGE_USE_NEXT === "1";
let apiBridge: AgentHostApiBridge | null = null;
let staticProtocolInstalled = false;
let nextProcess: ServerProcess | null = null;
let agentHostProcess: ReturnType<typeof utilityProcess.fork> | null = null;
let agentHostEndpoint: string | null = null;
let agentHostToken: string | null = null;
let agentHostReady = false;
let agentHostState: AgentHostState = "off";
let hostReadiness = initialHostReadiness();
let agentHostShutdownStarted = false;
let agentHostShutdownComplete = false;
let agentHostRestartAttempts: number[] = [];
const browserManagers = new Map<number, BrowserManager>();
let browserHostBridge: BrowserHostBridge | null = null;
let agentHostRestartTimer: ReturnType<typeof setTimeout> | null = null;
let isQuitting = false;
let logFilePath: string | null = null;
const DEFAULT_PORT = 30141;
// 冷启动分级超时：软超时（20s）只报告 + 通知 UI，硬超时（60s）才杀进程。
// 0.9.0 的 10s 直接 kill 会把慢机器上的正常启动变成"挂一次 + 退避重启"。
const AGENT_HOST_SHUTDOWN_TIMEOUT_MS = 4_000;
let serverState: ServerState = "starting";
let activePort: number | null = null;
let startupUiReady = false;
let restartAttempts: number[] = [];
let updateInstallState: UpdateInstallState = createUpdateInstallState();

export function setQuitting(val: boolean) {
  isQuitting = val;
}
export function getQuitting(): boolean {
  return isQuitting;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function getLogFilePath(): string {
  if (!logFilePath) {
    const logDir = app.getPath("logs");
    mkdirSync(logDir, { recursive: true });
    logFilePath = path.join(logDir, "main.log");
  }
  return logFilePath;
}

function writeLog(level: ElectronLogLevel, message: string, detail?: unknown) {
  try {
    appendFileSync(
      getLogFilePath(),
      formatElectronLogLine({ level, source: "electron-main", scope: deriveScope(message), message, detail }),
      "utf8",
    );
  } catch {
    // Avoid failing app startup because diagnostics cannot be written.
  }
}

function logInfo(message: string, detail?: unknown) {
  console.log(message, detail ?? "");
  writeLog("info", message, detail);
}

function logError(message: string, detail?: unknown) {
  console.error(message, detail ?? "");
  writeLog("error", message, detail);
}

function startupPageUrl(state: "starting" | "error" | "stopped", message?: string): string {
  const url = new URL(`file://${path.join(__dirname, "startup.html").replace(/\\/g, "/")}`);
  const hash = new URLSearchParams({ state });
  if (message) {
    hash.set("message", message);
  }
  url.hash = hash.toString();
  return url.toString();
}

function showStartupStateFor(window: BrowserWindow, state: "starting" | "error" | "stopped", message?: string) {
  if (window.isDestroyed()) {
    return;
  }
  void window.loadURL(startupPageUrl(state, message)).catch((err: unknown) => {
    // A newer navigation (e.g. the app URL right after opening a window) can
    // abort the startup page load; that is expected and not an error.
    if (err instanceof Error && err.message.includes("ERR_ABORTED")) {
      return;
    }
    logError("Failed to load startup page", err);
  });
}

function showStartupState(state: "starting" | "error" | "stopped", message?: string) {
  for (const window of appWindows) {
    showStartupStateFor(window, state, message);
  }
}

let startupStartedAt = Date.now();

/**
 * 启动页淡出：真正的应用 URL 加载前，先让 startup.html 把画面淡完，
 * 避免从品牌动画硬切到白屏。启动页里的动画在等待期间一直循环。
 */
async function fadeOutStartupPage(window: BrowserWindow, timeoutMs = 360): Promise<void> {
  if (window.isDestroyed() || window.webContents.isDestroyed()) {
    return;
  }
  if (!window.webContents.getURL().includes("startup.html")) {
    return;
  }
  try {
    await Promise.race([
      window.webContents.executeJavaScript(
        "window.__piforgeFadeOut ? window.__piforgeFadeOut() : Promise.resolve()",
        true,
      ),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  } catch (error) {
    // A dead renderer must never block startup; just load the app URL.
    logError("Startup page fade-out failed", error);
  }
}

function logStartupTiming(stage: string, detail?: unknown) {
  logInfo(`Startup timing: ${stage}`, { elapsedMs: Date.now() - startupStartedAt, detail });
}

// ---------------------------------------------------------------------------
// Port finding
// ---------------------------------------------------------------------------
function reservePort(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      server.close(() => resolve(addr && typeof addr === "object" ? addr.port : port));
    });
    server.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Agent Host lifecycle
// ---------------------------------------------------------------------------
function resolveAgentHostEntry(): string | null {
  const entryPath = app.isPackaged
    ? path.join(process.resourcesPath, "standalone", "agent-host", "index.js")
    : path.join(app.getAppPath(), "agent-host", "dist", "agent-host", "index.js");
  return existsSync(entryPath) ? entryPath : null;
}

/** Stable for the lifetime of the app run so a host restart keeps the same address. */
function createAgentHostEndpoint(): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\piforge-agent-${randomBytes(16).toString("hex")}`;
  }
  const runDir = path.join(app.getPath("userData"), "run");
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  return path.join(runDir, "agent-host.sock");
}

function agentHostEnvVars(): Record<string, string> {
  if (!agentHostEndpoint || !agentHostToken) return {};
  return {
    PIFORGE_AGENT_ENDPOINT: agentHostEndpoint,
    PIFORGE_AGENT_TOKEN: agentHostToken,
    // OOM 取证落盘位置（L1 收紧堆参数后的 soak 校验读它）。
    PIFORGE_HOST_OOM_FILE: path.join(app.getPath("userData"), "host-oom.json"),
  };
}

/** L1 生效中的堆上限（OOM 证据里要记录"当时限制"，否则没法判断是不是压太狠）。 */
let activeHostHeapLimits: { semiSpaceMb: number | null; oldSpaceMb: number | null } = {
  semiSpaceMb: null,
  oldSpaceMb: null,
};

function agentHostProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(childProcessEnv(process.env))) {
    if (value !== undefined) env[key] = value;
  }
  const heapEnv: Record<string, string> = {};
  if (activeHostHeapLimits.semiSpaceMb !== null) {
    heapEnv.PIFORGE_HOST_HEAP_SEMI_MB = String(activeHostHeapLimits.semiSpaceMb);
  }
  if (activeHostHeapLimits.oldSpaceMb !== null) {
    heapEnv.PIFORGE_HOST_HEAP_OLD_MB = String(activeHostHeapLimits.oldSpaceMb);
  }
  return { ...env, ...agentHostEnvVars(), ...heapEnv };
}

function isHostReadyMessage(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "host_ready"
  );
}

async function startAgentHost(): Promise<void> {
  if (agentHostProcess) return;

  const entry = resolveAgentHostEntry();
  if (!entry) {
    logError("Agent Host entry not found; continuing without host isolation", {
      expected: app.isPackaged
        ? "resources/standalone/agent-host/index.js"
        : "agent-host/dist/agent-host/index.js",
    });
    setHostReadiness(markHostStopped());
    return;
  }

  agentHostEndpoint ??= createAgentHostEndpoint();
  agentHostToken ??= randomBytes(32).toString("hex");

  // 诊断：`PIFORGE_HOST_CPU_PROFILE=1` 时给 Host 开 V8 CPU profile，
  // 用来定位"空闲还烧 CPU"的具体调用栈（产出的 .cpuprofile 可在
  // chrome://tracing 或 node --cpu-prof 后处理工具里打开）。
  const profileDir = process.env.PIFORGE_HOST_CPU_PROFILE?.trim();
  const profileFlags = profileDir
    ? ["--cpu-prof", "--cpu-prof-dir", path.resolve(profileDir), "--cpu-prof-interval", "500"]
    : [];

  /**
   * L1：只给 **host**（utilityProcess）收紧 V8 堆，不动 main / 渲染进程。
   * 实测 host RSS 289–357 MB → 173–195 MB（见 electron/host-heap.ts）；
   * `PIFORGE_HOST_HEAP=default` 回退到不干预。
   */
  const hostHeap = resolveHostHeapFlags({ env: process.env });
  activeHostHeapLimits = { semiSpaceMb: hostHeap.semiSpaceMb, oldSpaceMb: hostHeap.oldSpaceMb };
  // execArgv 顺序：L1 堆参数（`--js-flags=--max-old-space-size=N`）→ CPU profile → 实验参数。
  const extraExecArgv = (process.env.PIFORGE_HOST_EXEC_ARGV ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const execArgvParts = [...hostHeap.execArgv, ...profileFlags, ...extraExecArgv];
  const execArgv = execArgvParts.length > 0 ? execArgvParts : undefined;
  logInfo("Agent Host heap flags", {
    execArgv: execArgvParts,
    reason: hostHeap.reason,
    semiSpaceMb: hostHeap.semiSpaceMb,
    oldSpaceMb: hostHeap.oldSpaceMb,
  });

  const child = utilityProcess.fork(entry, [], {
    cwd: app.isPackaged ? path.join(process.resourcesPath, "standalone") : app.getAppPath(),
    env: agentHostProcessEnv(),
    stdio: "pipe",
    serviceName: "PiForge Agent Host",
    ...(execArgv ? { execArgv } : {}),
  });
  agentHostProcess = child;
  agentHostReady = false;
  setHostReadiness(markHostBooting());
  logStartupTiming("agent host spawned", { pid: child.pid });

  child.stdout?.on("data", (chunk: Buffer) => logInfo(`[AgentHost] ${chunk.toString().trim()}`));
  child.stderr?.on("data", (chunk: Buffer) => logError(`[AgentHost] ${chunk.toString().trim()}`));

  child.once("exit", (code) => {
    agentHostReady = false;
    setHostReadiness(markHostStopped());
    if (agentHostProcess === child) agentHostProcess = null;
    // OOM 归因：exit 134 / SIGABRT 基本都是堆爆（L1 收紧了 old-space，必须能分辨）。
    logError("Agent Host exited", {
      code,
      heapExhaustionSuspected: isHeapExhaustion({ exitCode: code }),
      heapLimits: activeHostHeapLimits,
    });
    scheduleAgentHostRestart();
  });

  /**
   * 就绪等待：软超时只报告（Host 继续在后面启动），硬超时才杀。
   * 这个 Promise 永远 resolve —— 调用方（app ready / 重启）不得被 Host 拖住。
   */
  await new Promise<void>((resolve) => {
    let settled = false;
    const clearTimers = () => {
      clearTimeout(softTimer);
      if (hardTimer) clearTimeout(hardTimer);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve();
    };
    const succeed = (detail?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimers();
      agentHostReady = true;
      setHostReadiness(markHostReady());
      logInfo("Agent Host ready", { pid: child.pid, endpoint: agentHostEndpoint, detail });
      logStartupTiming("agent host ready");
      startBrowserHostBridge();
      resolve();
    };

    let hardTimer: ReturnType<typeof setTimeout> | null = null;
    const softTimer = setTimeout(() => {
      const soft = onSoftTimeout(hostReadiness);
      setHostReadiness(soft.snapshot);
      if (soft.action !== "report") return;
      // 注意：这里**不**杀进程。慢机器上 Host 常在 20–60s 内自己就绪。
      logError("Agent Host still booting after soft timeout", {
        timeoutMs: AGENT_HOST_READY_TIMEOUT_MS,
        hardTimeoutMs: AGENT_HOST_HARD_TIMEOUT_MS,
      });
      hardTimer = setTimeout(() => {
        const hard = onHardTimeout(hostReadiness);
        if (hard.action !== "kill") return;
        logError("Agent Host failed to become ready; killing hung process", {
          timeoutMs: AGENT_HOST_HARD_TIMEOUT_MS,
        });
        setHostReadiness(markHostStopped());
        try {
          child.kill();
        } catch {
          // Already gone.
        }
        finish();
      }, AGENT_HOST_HARD_TIMEOUT_MS - AGENT_HOST_READY_TIMEOUT_MS);
    }, AGENT_HOST_READY_TIMEOUT_MS);

    child.on("message", (message: unknown) => {
      if (isHostReadyMessage(message)) succeed(message);
    });
    child.once("exit", (code) => {
      // 崩溃型失败（0.9.0 实测的 197 次 code=1 就是这条路径）：必须留下可 grep
      // 的审计行，否则 UI 只说"启动中"，日志里查不到为什么起不来。
      if (!agentHostReady) logError("Agent Host exited before becoming ready", { code });
      finish();
    });
    child.once("error", (type, location) => {
      logError("Agent Host process error", { type, location });
      finish();
    });
  });
}

/**
 * Host 状态广播：渲染进程据此显示"引擎启动中"而不是"引擎断开"。
 * 空窗口（启动早期）静默忽略 —— 第一个窗口创建后会主动拉一次快照。
 */
function setHostReadiness(next: ReturnType<typeof initialHostReadiness>) {
  hostReadiness = next;
  agentHostState = next.state;
  const payload = {
    state: next.state,
    ...describeHostState(next.state),
  };
  for (const window of appWindows) {
    if (!window.isDestroyed()) window.webContents.send("host-state", payload);
  }
}

function scheduleAgentHostRestart(): void {
  if (isQuitting || agentHostRestartTimer) return;

  const now = Date.now();
  agentHostRestartAttempts = agentHostRestartAttempts.filter((at) => now - at < 60_000);
  if (agentHostRestartAttempts.length >= 5) {
    logError("Agent Host restart limit reached; manual restart required");
    return;
  }
  agentHostRestartAttempts.push(now);
  const delay = Math.min(5_000, 500 * 2 ** (agentHostRestartAttempts.length - 1));
  logInfo("Scheduling Agent Host restart", {
    delayMs: delay,
    attempt: agentHostRestartAttempts.length,
  });
  agentHostRestartTimer = setTimeout(() => {
    agentHostRestartTimer = null;
    if (isQuitting) return;
    void startAgentHost();
  }, delay);
}

function stopAgentHost(): Promise<void> {
  if (agentHostRestartTimer) {
    clearTimeout(agentHostRestartTimer);
    agentHostRestartTimer = null;
  }
  const child = agentHostProcess;
  agentHostProcess = null;
  agentHostReady = false;

  if (!child) {
    agentHostShutdownComplete = true;
    setHostReadiness(markHostStopped());
    return Promise.resolve();
  }
  if (agentHostShutdownComplete) return Promise.resolve();
  agentHostShutdownStarted = true;

  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      agentHostShutdownComplete = true;
      resolve();
    };

    // Give the host time to drain: it kills every managed process tree before
    // exiting. If it hangs, kill the whole utility process tree so no dev
    // server survives the app.
    const timer = setTimeout(() => {
      logError("Agent Host did not exit in time; killing its process tree");
      const pid = child.pid;
      if (pid) {
        if (process.platform === "win32") {
          spawnSync("taskkill.exe", ["/PID", String(pid), "/F", "/T"], { windowsHide: true });
        } else {
          const error = killProcessDescendants(pid, "SIGKILL");
          if (error) logError("Failed to kill Agent Host descendants", error);
        }
      }
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      finish();
    }, AGENT_HOST_SHUTDOWN_TIMEOUT_MS);

    child.once("exit", finish);
    try {
      child.postMessage({ type: "shutdown", reason: "app-quit" });
    } catch {
      // Already gone; the exit listener (or the timeout) resolves us.
    }
  });
}

// ---------------------------------------------------------------------------
// Next.js server lifecycle
// ---------------------------------------------------------------------------
function startNextServer(port: number): ServerProcess {
  const isDev = !app.isPackaged;

  if (isDev) {
    // Dev: use 'node' (not process.execPath which is electron.exe) to start next dev
    const nextBin = require.resolve("next/dist/bin/next", { paths: [app.getAppPath()] });
    const proc = spawn("node", [nextBin, "dev", "-p", String(port)], {
      cwd: app.getAppPath(),
      env: {
        ...childProcessEnv(process.env),
        ...agentHostEnvVars(),
        NODE_ENV: process.env.NODE_ENV ?? "development",
        PORT: String(port),
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: "pipe",
    });
    return monitorNextServerProcess(
      wrapChildServerProcess(proc, killProcessTree),
      "Next.js dev server",
    );
  }

  // Production: macOS uses a background Electron utility process so the
  // server does not appear as a second bouncing app in the Dock. Other
  // platforms retain the ELECTRON_RUN_AS_NODE standalone path.
  const standaloneDir = path.join(process.resourcesPath, "standalone");
  const serverScript = path.join(standaloneDir, "server.js");
  const serverEnv = {
    ...childProcessEnv(process.env),
    ...agentHostEnvVars(),
    NODE_ENV: process.env.NODE_ENV ?? "production",
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
  };
  const proc = process.platform === "darwin"
    ? (() => {
        const utility = utilityProcess.fork(serverScript, [], {
          cwd: standaloneDir,
          env: serverEnv,
          stdio: "pipe",
          serviceName: "Pi Agent Next Server",
        });
        return wrapUtilityServerProcess(utility, (process) => {
          const pid = process.pid;
          const descendantError = pid
            ? killProcessDescendants(pid, "SIGKILL")
            : null;
          process.kill();
          return descendantError;
        });
      })()
    : wrapChildServerProcess(
        spawn(process.execPath, [serverScript], {
          cwd: standaloneDir,
          env: {
            ...serverEnv,
            ELECTRON_RUN_AS_NODE: "1",
          },
          stdio: "pipe",
        }),
        killProcessTree,
      );
  logInfo("Starting packaged Next.js server", { standaloneDir, serverScript, port });
  return monitorNextServerProcess(proc, "Packaged Next.js server");
}

function monitorNextServerProcess(proc: ServerProcess, label: string): ServerProcess {
  proc.stdout?.on("data", (d: Buffer) => logInfo(`[Next] ${d.toString().trim()}`));
  proc.stderr?.on("data", (d: Buffer) => logError(`[Next] ${d.toString().trim()}`));
  proc.on("exit", (code, signal) => handleNextProcessExit(label, code, signal));
  proc.on("error", (err) => handleNextProcessError(label, err));
  return proc;
}

async function restartNextServer(label: string) {
  const nextRestart = getNextRestartState({ now: Date.now(), attempts: restartAttempts, serverState, isQuitting });
  restartAttempts = nextRestart.attempts;

  if (!nextRestart.shouldRestart) {
    logError("Next.js server exited too often; automatic restart disabled", {
      attempts: nextRestart.attempts,
      windowMs: 60_000,
      label,
    });
    serverState = "stopped";
    showStartupState("stopped", `${label} 已退出`);
    return;
  }

  try {
    serverState = "starting";
    activePort = null;
    showStartupState("starting", "正在重新启动本地服务");
    const port = await choosePort({ startPort: DEFAULT_PORT, reservePort });
    activePort = port;
    nextProcess = startNextServer(port);
    await waitForNextServerReady(port, nextProcess, { requireHttpHealth: app.isPackaged });
    await showApp(port);
  } catch (err) {
    logError("Failed to restart Next.js server", err);
    serverState = "stopped";
    cleanup();
    activePort = null;
    showStartupState("stopped", "本地服务重启失败");
  }
}

function handleNextProcessExit(label: string, code: number | null, signal: NodeJS.Signals | null) {
  logInfo(`${label} exited`, { code, signal, serverState, isQuitting });

  if (isQuitting || serverState === "stopped") {
    return;
  }

  nextProcess = null;

  if (serverState === "starting") {
    serverState = "stopped";
    showStartupState("error", "本地服务启动失败");
    return;
  }

  void restartNextServer(label);
}

function handleNextProcessError(label: string, err: Error) {
  logError(`${label} process error`, err);

  if (isQuitting || serverState === "stopped") {
    return;
  }

  nextProcess = null;

  if (serverState === "starting") {
    serverState = "stopped";
    showStartupState("error", err.message);
    return;
  }

  void restartNextServer(label);
}

function cleanup() {
  const proc = nextProcess;
  nextProcess = null;

  if (proc && !proc.killed) {
    logInfo("Killing Next.js server process");
    const error = proc.terminate();
    if (error) {
      logError("Failed to kill Next.js server process tree", error);
    }
  }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
/**
 * BrowserWindow / 任务栏图标。
 *
 * macOS 由 .app bundle 接管（不用 window icon），Windows 与 Linux 显式指向
 * `build/icon.ico` / `build/icon.png`。打包后这两个文件在 app.asar 里（
 * electron-builder.yml 的 `files:` 含 build/*），开发时就是仓库根目录。
 * 加载失败时回退到不给 icon，避免把空 NativeImage 传给窗口。
 */
function loadWindowIcon(): Electron.NativeImage | undefined {
  if (process.platform === "darwin") return undefined;
  const iconPath = getAppIconPath(app.getAppPath());
  try {
    if (!existsSync(iconPath)) {
      logError("App icon file is missing", iconPath);
      return undefined;
    }
    const image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) {
      logError("App icon could not be decoded", iconPath);
      return undefined;
    }
    return image;
  } catch (error) {
    logError("App icon could not be loaded", error);
    return undefined;
  }
}

function createWindow(options: { initialPath?: string; showStartup?: boolean } = {}): BrowserWindow {
  // 测量钩子：`PIFORGE_OPEN_PATH=/?session=<id>` 让冒烟/采样直接打开一个真实会话
  // （renderer 的内存只有装了长 transcript 才可比，空界面没有参考价值）。
  const initialPath = normalizeWindowPath(options.initialPath ?? process.env.PIFORGE_OPEN_PATH);
  const showStartup = options.showStartup ?? true;
  const windowIcon = loadWindowIcon();
  // 诊断：`PIFORGE_WINDOW_SIZE=800x600` 覆盖默认窗口尺寸，用来判断 GPU 进程
  // 的 RSS 是否随合成面积变化（B 项"gpu 瘦身"的归因实验）。
  const sizeOverride = /^(\d+)x(\d+)$/.exec(process.env.PIFORGE_WINDOW_SIZE ?? "");
  const window = new BrowserWindow({
    width: sizeOverride ? Number(sizeOverride[1]) : 1400,
    height: sizeOverride ? Number(sizeOverride[2]) : 900,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: "hidden",
    titleBarOverlay: titleBarOverlayOptions(),
    title: "PiForge",
    ...(windowIcon ? { icon: windowIcon } : {}),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      // Electron 官方强烈推荐启用 sandbox：显著缩小渲染进程攻击面。
      // preload 只用 contextBridge + ipcRenderer.{on,off,invoke,send}，
      // 这些 API 在 sandbox 模式下都可用，不会破坏功能。
      sandbox: true,
      // The built-in browser is a Main-owned WebContentsView (stage 9).
      // Renderer webviews are disabled so Next/Renderer cannot instantiate one.
      webviewTag: false,
      // 背景节流保持开启（Electron 默认值）：0.9.0 为了"后台也不降帧"把它关掉，
      // 结果窗口在托盘/被遮挡时合成器仍按 60fps 跑装饰动画，实测空闲渲染进程
      // 105% CPU。流式期间由渲染进程调 `setStreamingThrottle(true)` 临时关闭，
      // 流结束或窗口失焦后主进程自动恢复。
      backgroundThrottling: true,
    },
  });

  appWindows.add(window);
  windowPaths.set(window, initialPath);
  if (!mainWindow) {
    mainWindow = window;
  }
  lastFocusedWindow = window;

  // 诊断：`PIFORGE_DEBUG_RENDERER=1` 时把渲染进程的 console 转发到主进程日志
  // （用来定位"谁在定时发请求"这类问题；默认关闭，不影响正常日志体积）。
  if (process.env.PIFORGE_DEBUG_RENDERER === "1") {
    window.webContents.on("console-message", (event) => {
      logInfo(`[renderer] ${event.message}`, {
        level: event.level,
        line: event.lineNumber,
        source: event.sourceId,
      });
    });
  }

  installNavigationGuards(window);
  installWebviewSecurity(window);
  installCrashRecovery(window);

  // Inject a Content-Security-Policy header into every response loaded in the
  // app. Next.js does not emit CSP on its own, so without this a single XSS
  // (e.g. from a compromised npm package or local route) could drive the
  // preload-exposed electronAPI (quitAndInstall, select directory, ...). The
  // port is re-read on every callback so restarts / port switches pick up the
  // new value automatically. Policy builder mirrors lib/csp.ts (see
  // electron/csp.ts). startup.html ships its own stricter CSP via a meta tag
  // and is unaffected. All windows share the default session, so install the
  // hook once.
  if (!sessionCspInstalled) {
    sessionCspInstalled = true;
    window.webContents.session.webRequest.onHeadersReceived((details, callback) => {
      const port = activePort ?? 0;
      const csp = buildElectronCspHeader(port);
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [csp],
        },
      });
    });
  }

  if (showStartup) {
    showStartupStateFor(window, "starting");
  }

  window.once("ready-to-show", () => {
    // 诊断：`PIFORGE_WINDOW_HIDDEN=1` 建窗但不显示，用来把"可见窗口的空闲 CPU"
    // 和"隐藏窗口（Chromium 后台节流）"分开测，避免采样条件不一致。
    if (process.env.PIFORGE_WINDOW_HIDDEN === "1") return;
    window.show();
  });

  window.on("focus", () => {
    lastFocusedWindow = window;
  });

  // The primary window hides to the tray (tray app behaviour). Extra project
  // windows close normally so they do not accumulate as invisible windows.
  window.on("close", (e) => {
    if (!isQuitting && window === mainWindow) {
      e.preventDefault();
      window.hide();
    }
  });

  window.on("closed", () => {
    appWindows.delete(window);
    if (lastFocusedWindow === window) {
      lastFocusedWindow = null;
    }
    if (mainWindow === window) {
      startupUiReady = false;
      mainWindow = [...appWindows].find((candidate) => !candidate.isDestroyed()) ?? null;
    }
  });

  return window;
}

async function loadAppUrl(window: BrowserWindow, port: number, appPath: string): Promise<void> {
  const proc = nextProcess;
  if (!proc) {
    throw new Error("Next.js server process unavailable while loading app URL");
  }
  if (window.isDestroyed()) {
    throw new Error("App window unavailable while loading app URL");
  }

  const navigationAbort = new AbortController();
  const abortForProcessExit = () => {
    navigationAbort.abort(new Error("App navigation cancelled: Next.js server process exited"));
  };
  const abortForWindowClose = () => {
    navigationAbort.abort(new Error("App navigation cancelled: app window was destroyed"));
  };
  const abortForQuit = () => {
    navigationAbort.abort(new Error("App navigation cancelled: application is quitting"));
  };
  proc.once("exit", abortForProcessExit);
  proc.once("error", abortForProcessExit);
  window.once("closed", abortForWindowClose);
  app.once("before-quit", abortForQuit);

  const assertCurrentNavigation = () => {
    if (isQuitting) {
      throw new Error("App navigation cancelled: application is quitting");
    }
    if (window.isDestroyed()) {
      throw new Error("App navigation cancelled: app window was destroyed");
    }
    if (nextProcess !== proc) {
      throw new Error("App navigation cancelled: Next.js server process changed");
    }
    if (proc.exitCode !== null) {
      throw new Error("App navigation cancelled: Next.js server process exited");
    }
    if (serverState !== "starting" && serverState !== "ready") {
      throw new Error(`App navigation cancelled from server state: ${serverState}`);
    }
  };

  try {
    await loadPageWithRetry(
      `http://127.0.0.1:${port}${appPath}`,
      async (url) => {
        assertCurrentNavigation();
        await fadeOutStartupPage(window);
        assertCurrentNavigation();
        await window.loadURL(url);
      },
      {
        signal: navigationAbort.signal,
        cancelAttempt: () => {
          if (!window.isDestroyed()) {
            window.webContents.stop();
          }
        },
        shouldRetry: () => {
          try {
            assertCurrentNavigation();
            return true;
          } catch {
            return false;
          }
        },
      }
    );
  } finally {
    proc.off("exit", abortForProcessExit);
    proc.off("error", abortForProcessExit);
    window.off("closed", abortForWindowClose);
    app.off("before-quit", abortForQuit);
  }
  assertCurrentNavigation();
}

/**
 * 解析静态直出的根目录。
 *   - 打包：`resources/static`（electron-builder 从 `out/` 拷进去）；
 *   - 开发：仓库根的 `out/`（`npm run build:static` 产出）。
 */
function resolveStaticRoot(): string | null {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, "static")]
    : [path.join(app.getAppPath(), "out")];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "index.html"))) return candidate;
  }
  return null;
}

/** 安装 `piforge://` 协议：静态资源 + `/api/**` → Agent Host。 */
function installStaticProtocol(): void {
  if (staticProtocolInstalled) return;
  staticProtocolInstalled = true;
  const root = resolveStaticRoot();
  logInfo("Installing static app protocol", {
    root: root ?? "(missing)",
    mode: "static",
  });
  const handler = createStaticAppHandler({
    root,
    getBridge: () => apiBridge,
    log: (message, detail) => logError(message, detail),
    csp: buildStaticAppCspHeader(),
  });
  protocol.handle(STATIC_APP_SCHEME, (request) => handler(request));
}

function staticAppUrl(appPath: string): string {
  const normalized = appPath.startsWith("/") ? appPath : `/${appPath}`;
  return `${STATIC_APP_ORIGIN}${normalized}`;
}

/** 静态模式下的窗口加载：没有服务端，只有协议处理器。 */
async function loadStaticAppUrl(window: BrowserWindow, appPath: string): Promise<void> {
  if (window.isDestroyed()) {
    throw new Error("App window unavailable while loading app URL");
  }
  const url = staticAppUrl(appPath);
  const navigationAbort = new AbortController();
  const abortForWindowClose = () =>
    navigationAbort.abort(new Error("App navigation cancelled: app window was destroyed"));
  const abortForQuit = () =>
    navigationAbort.abort(new Error("App navigation cancelled: application is quitting"));
  window.once("closed", abortForWindowClose);
  app.once("before-quit", abortForQuit);
  try {
    await fadeOutStartupPage(window);
    if (window.isDestroyed() || isQuitting) return;
    await window.loadURL(url);
  } finally {
    window.off("closed", abortForWindowClose);
    app.off("before-quit", abortForQuit);
  }
}

/** 静态模式的首屏：立刻加载，不等 Agent Host（Host 由 UI 显示"启动中"）。 */
async function showStaticApp(): Promise<void> {
  logStartupTiming("loading static app url", { origin: STATIC_APP_ORIGIN });
  const windows = [...appWindows].filter((window) => !window.isDestroyed());
  if (windows.length === 0) {
    throw new Error("No app window available while loading app URL");
  }
  for (const window of windows) {
    await loadStaticAppUrl(window, windowPaths.get(window) ?? "/");
  }
  serverState = "ready";
  logStartupTiming("static app url loaded");
}

async function showApp(port: number): Promise<void> {
  activePort = port;
  logStartupTiming("loading app url", { port });
  const windows = [...appWindows].filter((window) => !window.isDestroyed());
  if (windows.length === 0) {
    throw new Error("No app window available while loading app URL");
  }
  if (!nextProcess) {
    throw new Error("Next.js server process unavailable while loading app URL");
  }

  for (const window of windows) {
    await loadAppUrl(window, port, windowPaths.get(window) ?? "/");
  }
  serverState = "ready";
}

/**
 * Opens an additional project window against the shared local server.
 * The new window starts on `path` (usually `/?cwd=...`) and keeps the primary
 * window untouched, so two projects can be visible side by side.
 */
function openNewWindow(path?: string): BrowserWindow {
  const appReady = !USE_NEXT_SERVER
    ? serverState === "ready"
    : serverState === "ready" && Boolean(activePort) && Boolean(nextProcess) && nextProcess?.exitCode === null;
  const window = createWindow({ initialPath: path, showStartup: !appReady });
  if (appReady) {
    const targetPath = windowPaths.get(window) ?? "/";
    const load = USE_NEXT_SERVER && activePort
      ? loadAppUrl(window, activePort, targetPath)
      : loadStaticAppUrl(window, targetPath);
    void load.catch((err: unknown) => {
      logError("Failed to load app URL in new window", err);
      showStartupStateFor(window, "error", err instanceof Error ? err.message : String(err));
    });
  }
  return window;
}

function isAllowedAppUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);

    if (parsed.protocol === "file:") {
      return parsed.pathname.endsWith("/startup.html");
    }

    if (parsed.protocol === `${STATIC_APP_SCHEME}:` && parsed.host === "app") {
      return true;
    }

    return parsed.protocol === "http:" && parsed.hostname === "127.0.0.1" && parsed.port === String(activePort);
  } catch {
    return false;
  }
}

// Recover from renderer process crashes: without a handler here the window
// stays blank forever after the renderer dies (OOM, GPU crash, ...).
// Auto-reload is bounded by crash-recovery.ts to avoid crash loops.
function installCrashRecovery(window: BrowserWindow) {
  let reloadAttempts: number[] = [];
  window.webContents.on("render-process-gone", (_event, details) => {
    logError("Renderer process gone", details);
    const next = getNextCrashReloadState({
      now: Date.now(),
      reason: details.reason,
      attempts: reloadAttempts,
      isQuitting,
    });
    reloadAttempts = next.attempts;
    if (!next.shouldReload) {
      logError("Renderer crash auto-reload skipped", { reason: details.reason });
      // 达到自动 reload 上限后窗口会一直白屏；复用 startup.html 给出可见提示
      // （与 server 退出路径的 showStartupState("stopped", …) 兜底一致）。
      // clean-exit / isQuitting 属于正常退出流程，不应展示"已停止"错误页；
      // 纯函数对这两种情况在达到上限判断之前就直接返回 false，因此这里的
      // 条件恰好只命中"崩溃次数达上限"这一种情况。
      if (details.reason !== "clean-exit" && !isQuitting && !window.isDestroyed()) {
        showStartupState("stopped", "页面多次崩溃，已停止自动恢复");
      }
      return;
    }
    if (window.isDestroyed()) {
      return;
    }
    logInfo("Reloading renderer after crash");
    window.webContents.reload();
  });
}

function installNavigationGuards(window: BrowserWindow) {
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedAppUrl(url)) {
      event.preventDefault();
      logError("Blocked navigation", { url });
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      void shell.openExternal(url).catch((err) => logError("Failed to open external URL", err));
    } else {
      logError("Blocked window open", { url });
    }
    return { action: "deny" };
  });
}

// ---------------------------------------------------------------------------
// Built-in browser (right panel <webview>)
// ---------------------------------------------------------------------------
/** Dedicated partition: previewed pages must not share the app session/CSP. */
const BROWSER_PARTITION = "persist:piforge-browser";
const BROWSER_PREVIEW_PROTOCOLS = ["http:", "https:"];
let browserPermissionHandlerInstalled = false;

function isAllowedPreviewUrl(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  if (rawUrl === "about:blank") return true;
  try {
    return BROWSER_PREVIEW_PROTOCOLS.includes(new URL(rawUrl).protocol);
  } catch {
    return false;
  }
}

/**
 * Harden every webview the renderer attaches, and give guests their own
 * session partition. Without the partition switch the app's injected CSP would
 * apply to every previewed site and break it.
 */
function installWebviewSecurity(window: BrowserWindow) {
  window.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
    params.partition = BROWSER_PARTITION;
    if (!isAllowedPreviewUrl(params.src)) {
      event.preventDefault();
      logError("Blocked webview attach", { src: params.src });
    }
  });

  if (!browserPermissionHandlerInstalled) {
    browserPermissionHandlerInstalled = true;
    session.fromPartition(BROWSER_PARTITION).setPermissionRequestHandler((_contents, permission, callback) => {
      // Camera/mic/geolocation/notifications are not needed for a preview pane.
      logInfo("Denied browser preview permission", { permission });
      callback(false);
    });
  }
}

/**
 * One Main-owned WebContentsView per app window. Renderer only reports the DOM
 * placeholder bounds; it never creates or navigates the view itself.
 */
function getBrowserManager(window: BrowserWindow): BrowserManager {
  const existing = browserManagers.get(window.id);
  if (existing) return existing;
  const view = new WebContentsView({
    webPreferences: {
      partition: BROWSER_PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  view.setBackgroundColor("#ffffff");
  window.contentView.addChildView(view);
  const manager = new BrowserManager({
    createSurface: () => ({
      webContents: view.webContents as unknown as import("./browser-manager").BrowserPageContents,
      setBounds: (bounds) => view.setBounds(bounds),
      setVisible: (visible) => view.setVisible(visible),
      close: () => {
        try {
          window.contentView.removeChildView(view);
        } catch {
          // Window may already be gone.
        }
        view.webContents.close();
      },
    }),
  });
  manager.onStateChange((state) => {
    if (!window.isDestroyed()) window.webContents.send("browser:state", state);
  });
  manager.setVisible(false);
  browserManagers.set(window.id, manager);
  window.once("closed", () => {
    manager.destroy();
    browserManagers.delete(window.id);
  });
  return manager;
}

function startBrowserHostBridge(): void {
  if (!agentHostEndpoint || !agentHostToken) return;
  // 诊断开关：关掉浏览器桥（它每 3s poll + 每 2.5s pushSnapshot，且会创建
  // WebContentsView）。用来判断空闲 CPU 是否来自这条路径。
  if (process.env.PIFORGE_DISABLE_BROWSER_BRIDGE === "1") {
    logInfo("Browser host bridge disabled by env");
    return;
  }
  browserHostBridge?.stop();
  browserHostBridge = new BrowserHostBridge({
    endpoint: agentHostEndpoint,
    token: agentHostToken,
    connect: (endpoint) => net.connect(endpoint),
    getManager: () =>
      mainWindow && !mainWindow.isDestroyed() ? getBrowserManager(mainWindow) : null,
    onAgentOpen: () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send("browser:agent-open");
      if (!mainWindow.isVisible()) mainWindow.show();
    },
  });
  browserHostBridge.start();
}

/** Guest pages open links in place instead of spawning unmanaged windows. */
function installWebviewGuests() {
  app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() !== "webview") return;

    contents.setWindowOpenHandler(({ url }) => {
      if (isAllowedPreviewUrl(url)) {
        void contents.loadURL(url).catch((error) => logError("Failed to open preview URL", error));
      } else {
        logError("Blocked preview window open", { url });
      }
      return { action: "deny" };
    });

    contents.on("will-navigate", (event, url) => {
      if (!isAllowedPreviewUrl(url)) {
        event.preventDefault();
        logError("Blocked preview navigation", { url });
      }
    });
  });

  // Local dev servers commonly use self-signed HTTPS. Only loopback hosts are
  // exempted, so the app itself never accepts an invalid certificate.
  app.on("certificate-error", (event, _contents, url, error, _certificate, callback) => {
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      callback(false);
      return;
    }
    if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
      logInfo("Allowing self-signed certificate for local preview", { url, error });
      event.preventDefault();
      callback(true);
      return;
    }
    callback(false);
  });
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------
function registerIpcHandlers() {
  // 启动早期状态查询：窗口可能已经加载了应用 URL，而 host-state 事件在窗口
  // 就绪前就发过了；渲染进程 mount 时从这里拉一次当前快照。
  ipcMain.handle("host-state:get", () => ({
    state: agentHostState,
    ...describeHostState(agentHostState),
  }));

  /**
   * 流式期间临时关掉背景节流（打字机要按帧走），结束后恢复。
   * 只影响发消息的窗口；其它窗口 / 空闲窗口仍走 Electron 默认节流。
   */
  ipcMain.on("window:streaming-throttle", (event, enabled: unknown) => {
    const contents = event.sender;
    if (contents.isDestroyed()) return;
    contents.setBackgroundThrottling(enabled !== true);
  });

  ipcMain.handle("select-directory", async () => {
    const targetWindow = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined;
    const result = targetWindow
      ? await dialog.showOpenDialog(targetWindow, {
          properties: ["openDirectory"],
        })
      : await dialog.showOpenDialog({
          properties: ["openDirectory"],
        });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle("new-window", async (_event, requestedPath: unknown) => {
    openNewWindow(normalizeWindowPath(requestedPath));
    return { ok: true };
  });

  // Screenshot for the agent's `web_preview` tool. The guest lives in the
  // renderer, so capture runs here (main holds the only reliable capturePage).
  ipcMain.handle("browser:set-bounds", (event, bounds: unknown, visible: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || !bounds || typeof bounds !== "object") return { ok: false };
    const value = bounds as Record<string, unknown>;
    if (![value.x, value.y, value.width, value.height].every((part) => typeof part === "number")) {
      return { ok: false };
    }
    getBrowserManager(window).setBounds(
      { x: value.x as number, y: value.y as number, width: value.width as number, height: value.height as number },
      visible === true,
    );
    return { ok: true };
  });

  ipcMain.handle("browser:navigate", async (event, url: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || typeof url !== "string") return { ok: false, error: "url is required" };
    try {
      await getBrowserManager(window).navigate(url);
      return { ok: true, state: getBrowserManager(window).getState() };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle("browser:action", async (event, action: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return { ok: false };
    if (action !== "back" && action !== "forward" && action !== "reload" && action !== "stop") {
      return { ok: false, error: "unsupported browser action" };
    }
    const manager = getBrowserManager(window);
    if (action === "stop") {
      manager.stop();
      return { ok: true, state: manager.getState() };
    }
    const result = await manager.executeCommand({ id: "renderer", kind: action });
    return { ok: result.ok, error: result.error, state: manager.getState() };
  });

  ipcMain.handle("browser:get-state", (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    return window ? getBrowserManager(window).getState() : null;
  });

  ipcMain.handle("capture-webview", async (_event, contentsId: unknown) => {
    if (typeof contentsId !== "number" || !Number.isFinite(contentsId)) return null;
    const guest = webContents.fromId(contentsId);
    if (!guest || guest.isDestroyed() || guest.getType() !== "webview") return null;
    // Only ever capture guests hosted by one of our own windows.
    const host = guest.hostWebContents;
    const hostWindow = host ? BrowserWindow.fromWebContents(host) : null;
    if (!hostWindow || !appWindows.has(hostWindow)) return null;
    try {
      const image = await guest.capturePage();
      if (image.isEmpty()) return null;
      return { data: image.toPNG().toString("base64"), mimeType: "image/png" };
    } catch (error) {
      logError("Failed to capture webview", error);
      return null;
    }
  });

  ipcMain.handle("quit-and-install", async () => {
    logInfo("quitAndInstall requested from renderer");
    const decision = decideQuitAndInstall(updateInstallState);
    if (!decision.allowed) {
      logInfo("quitAndInstall refused", { reason: decision.reason });
      return { ok: false, error: decision.reason };
    }
    setQuitting(true);
    const { autoUpdater } = await import("electron-updater");
    autoUpdater.quitAndInstall();
    return { ok: true, version: decision.version };
  });

  ipcMain.handle("pi-core:install", async (_event, version: unknown) => {
    if (typeof version !== "string") return { ok: false, error: "版本号缺失" };
    const target = resolvePiCoreTarget({
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
    });
    logInfo("pi core install requested", { version, dir: target.dir, mode: target.mode });
    const result = await installPiCoreVersion({
      version,
      target,
      onLog: (chunk) => {
        // 流式给 UI 看进度文案（npm 输出，非敏感）
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) window.webContents.send("pi-core:progress", chunk);
        }
      },
    });
    if (result.ok) logInfo("pi core installed", { version: result.installed });
    else logError("pi core install failed", { version, error: result.error });
    return result;
  });

  ipcMain.handle("pi-core:relaunch", async () => {
    logInfo("pi core relaunch requested from renderer");
    setQuitting(true);
    app.relaunch();
    app.exit(0);
    return { ok: true };
  });

  ipcMain.on("set-theme", (event, theme: unknown) => {
    const target = BrowserWindow.fromWebContents(event.sender);
    applyTitleBarOverlayTheme(target, theme);
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
// Observability only: record child process deaths (GPU, utility, ...).
// No auto-reload here — Electron already falls back to software rendering
// when the GPU process dies, and blindly reloading risks crash loops;
// renderer crashes have their own bounded recovery in installCrashRecovery.
app.on("child-process-gone", (_event, details) => {
  logError("Child process gone", {
    type: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
  });
});

app.on("before-quit", (event) => {
  logInfo("before-quit");
  isQuitting = true;
  browserHostBridge?.stop();
  browserHostBridge = null;
  apiBridge?.stop();
  apiBridge = null;
  cleanup();

  // Delay the quit until the host has drained and killed its managed process
  // trees. Without this, utilityProcess termination would orphan dev servers.
  if (agentHostProcess && !agentHostShutdownComplete) {
    event.preventDefault();
    if (!agentHostShutdownStarted) {
      logInfo("Stopping Agent Host");
      void stopAgentHost().finally(() => {
        app.quit();
      });
    }
  }
});

app.on("window-all-closed", () => {
  // Do nothing — keep running in tray
});

app.on("activate", () => {
  const target =
    lastFocusedWindow && !lastFocusedWindow.isDestroyed()
      ? lastFocusedWindow
      : mainWindow;
  if (target) {
    target.show();
    target.focus();
  }
});

// 诊断/测量：`PIFORGE_EXIT_AFTER_MS=<n>` 让应用自己干净退出（CPU profile 才会落盘）。
const exitAfterMs = Number(process.env.PIFORGE_EXIT_AFTER_MS);
if (Number.isFinite(exitAfterMs) && exitAfterMs > 0) {
  setTimeout(() => {
    logInfo("Exiting after PIFORGE_EXIT_AFTER_MS", { exitAfterMs });
    setQuitting(true);
    app.quit();
  }, exitAfterMs).unref?.();
}

app.whenReady().then(async () => {
  if (process.env.SMOKE_BROWSER === "1") {
    const { runBrowserSmoke } = await import("./browser-smoke");
    await runBrowserSmoke();
    return;
  }
  startupStartedAt = Date.now();
  logStartupTiming("app ready");
  logInfo("Runtime versions", {
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    node: process.versions.node,
    v8: process.versions.v8,
    gpuSwitches: gpuSwitchesFrom(process.argv),
    gpuEnvFlags: gpuFlagsEnv ?? null,
    // L1 取证：主进程侧看到的 V8 堆上限（`--js-flags` 是否真的生效）。
    heapLimitMb: Math.round(v8.getHeapStatistics().heap_size_limit / 1048576),
    jsFlags: app.commandLine.getSwitchValue("js-flags"),
    hardwareAccelerationDisabled: process.env.PIFORGE_DISABLE_HW_ACCEL === "1",
    gpuFeatureStatus: (() => {
      try {
        return app.getGPUFeatureStatus();
      } catch {
        return null;
      }
    })(),
  });
  // 记录本轮 GPU 观测，供下一轮 decide（softwareLaunches 计数 + 30 天过期）。
  try {
    const observed = (() => {
      try {
        return app.getGPUFeatureStatus().gpu_compositing;
      } catch {
        return null;
      }
    })();
    const featureStatus = (() => {
      try {
        return app.getGPUFeatureStatus() as unknown as Record<string, string>;
      } catch {
        return null;
      }
    })();
    const evidence = recordGpuObservation(
      readGpuEvidence(),
      {
        compositing: observed,
        featureStatus,
        decision: { mode: gpuDecision.mode, code: gpuDecision.code },
      },
    );
    mkdirSync(app.getPath("userData"), { recursive: true });
    writeFileSync(
      path.join(app.getPath("userData"), GPU_EVIDENCE_FILE),
      `${JSON.stringify(evidence, null, 2)}
`,
      "utf8",
    );
    // 独立的可 grep 行（自愈 / 强制覆盖 / 首次决策都会出现）。
    if (gpuReEvaluation) logInfo(gpuReEvaluation);
    logInfo("GPU mode", {
      mode: gpuDecision.mode,
      code: gpuDecision.code,
      reason: gpuDecision.reason,
      switches: gpuDecision.switches,
      observedCompositing: observed,
      reEvaluated: gpuReEvaluation,
      evidence,
    });
  } catch (error) {
    logError("Failed to record GPU evidence", error);
  }

  registerIpcHandlers();
  installWebviewGuests();

  try {
    // Agent Host 的启动最早开始：它只需要 endpoint + token（同步铸出），
    // 不依赖端口 / 窗口。先发它，让它与端口探测、建窗、Next 启动完全重叠。
    agentHostEndpoint ??= createAgentHostEndpoint();
    agentHostToken ??= randomBytes(32).toString("hex");
    const agentHostStart = startAgentHost();
    logStartupTiming("agent host kickoff");

    // `/api/**` 的传输桥：静态模式下它是唯一的数据通道，必须在装协议前就绪。
    apiBridge = new AgentHostApiBridge({
      endpoint: agentHostEndpoint,
      token: agentHostToken,
      log: (message, detail) => logInfo(message, detail),
    });

    // **绝不把首屏挂在 Host 上**：Host 在后台就绪，渲染进程按
    // useHostHealth / host-state 事件显示“引擎启动中”。
    void agentHostStart.then(() => {
      logStartupTiming("agent host startup finished", { ready: agentHostReady });
    });

    let port: number | null = null;
    if (USE_NEXT_SERVER) {
      port = await choosePort({ startPort: DEFAULT_PORT, reservePort });
      logStartupTiming("port selected", { port });
      activePort = port;
      logInfo(`Using port ${port}`);
    }

    serverState = "starting";
    createWindow();
    logStartupTiming("window created");
    createTray(mainWindow!, { onNewWindow: () => { openNewWindow(); } });
    startupUiReady = true;

    if (USE_NEXT_SERVER) {
      // ---- 回退路径（PIFORGE_USE_NEXT=1）：保留 0.9.0 的 Next standalone ----
      nextProcess = startNextServer(port!);
      logStartupTiming("next process spawned");
      logInfo("Waiting for Next.js server...");
      await waitForNextServerReady(port!, nextProcess, { requireHttpHealth: app.isPackaged });
      logStartupTiming("next server ready");
      logInfo("Next.js server is ready");
      await showApp(port!);
    } else {
      // ---- 默认路径（P1-4）：静态直出 + 命名管道，零内部端口 ----
      installStaticProtocol();
      await showStaticApp();
    }

    // ---- 静态直出 UI 冒烟（P1-4 验收）------------------------------------
    // 打包版 + dev 都能跑：等 Host 就绪后，在渲染进程里断言 Workbench 挂载了、
    // 且 `/api/**` 能经 protocol → 命名管道拿到 Host 的真实响应。
    // 诊断开关：把渲染进程里的动画/过渡全停掉，用来判定空闲 CPU 是否来自 CSS 合成。
    if (process.env.PIFORGE_SMOKE_FREEZE_CSS === "1" && mainWindow && !mainWindow.isDestroyed()) {
      try {
        await mainWindow.webContents.insertCSS(
          "*, *::before, *::after { animation: none !important; transition: none !important; }",
        );
        logInfo("Froze renderer CSS animations (diagnostic)");
      } catch (error) {
        logError("Failed to freeze renderer CSS", error);
      }
    }

    if (process.env.PIFORGE_DEBUG_RENDERER === "1" && mainWindow && !mainWindow.isDestroyed()) {
      void mainWindow.webContents.executeJavaScript("window.__piforgePerf = true;", true).catch(() => {});
    }

    if (process.env.PIFORGE_SMOKE_UI === "1" && mainWindow && !mainWindow.isDestroyed()) {
      const smokeWindow = mainWindow;
      for (const waitUntil = Date.now() + 30_000; Date.now() < waitUntil && !agentHostReady; ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      // 等页面真正有内容：容器挂载与首屏数据到达之间可能有几百毫秒到数秒的窗口，
      // 单次读取会让冒烟偶发"bodyLength 过短"的假红（本轮踩过一次）。
      try {
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const length = await smokeWindow.webContents.executeJavaScript(
            "document.body.innerText.length",
            true,
          );
          if (typeof length === "number" && length >= 500) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      } catch {
        // 渲染进程还没准备好：继续走下面的断言（失败信息里会体现）
      }
      try {
        const result = await smokeWindow.webContents.executeJavaScript(
          `(async () => {
             const health = await fetch("/api/health", { cache: "no-store" }).then((r) => r.json()).catch((e) => ({ error: String(e) }));
             const sessions = await fetch("/api/sessions", { cache: "no-store" }).then((r) => r.ok).catch(() => false);
             // Token 护栏（P2-2 / P2-3a）是否渲染：只读 DOM 属性，不触发任何请求。
             const guard = document.querySelector("[data-token-guard]");
             return {
               url: location.href,
               title: document.title,
               bodyLength: document.body.innerText.length,
               hasComposer: Boolean(document.querySelector("textarea")),
               guard: guard ? guard.getAttribute("data-token-guard") : null,
               guardText: guard ? guard.textContent?.slice(0, 80) ?? null : null,
               health,
               sessionsOk: sessions,
             };
           })()`,
          true,
        );
        logInfo("Static UI smoke", result);
      } catch (error) {
        logError("Static UI smoke failed", error);
      }
      if (process.env.PIFORGE_SMOKE_EXIT === "1") {
        setTimeout(() => app.quit(), 100);
      }
    }

    if (process.env.SMOKE_FLEET === "1" && mainWindow) {
      const { runFleetSmoke } = await import("./fleet-smoke");
      await runFleetSmoke(mainWindow);
      return;
    }

    // Auto-update check (production only, delayed 30s). Without an update feed
    // electron-builder emits no app-update.yml; skip the check instead of
    // letting electron-updater reject on a missing config file.
    if (app.isPackaged && existsSync(path.join(process.resourcesPath, "app-update.yml"))) {
      setTimeout(async () => {
        try {
          const { autoUpdater } = await import("electron-updater");
          // 不自动下载：让用户决定是否下载（避免流量敏感环境静默下载大文件，
          // 也避免渲染进程 XSS 触发 quitAndInstall 路径）。
          autoUpdater.autoDownload = false;
          // Downloaded updates install when the app quits normally (the task is
          // over); "Restart Now" in the downloaded dialog is the immediate path.
          autoUpdater.autoInstallOnAppQuit = true;
          logInfo("Checking for updates");

          // Forward update events to renderer
          autoUpdater.on("checking-for-update", () => {
            logInfo("autoUpdater checking-for-update");
          });

          autoUpdater.on("update-available", (info: UpdateInfo) => {
            logInfo("autoUpdater update-available", info);
            // Notify renderer (if window is alive) for in-app banner
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send("update-available", { version: info.version });
            }
            // 弹 dialog 问用户是否下载（因为 autoDownload=false）
            // Fallback dialog: works with or without a parent window（与 update-downloaded 一致）
            const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
            const options = {
              type: "info" as const,
              title: "Update Available",
              message: `A new version (${info.version}) is available.`,
              detail: "Download and install now? The app will restart after download completes.",
              buttons: ["Download", "Later"],
              defaultId: 0,
              cancelId: 1,
            };
            const dialogPromise = parent
              ? dialog.showMessageBox(parent, options)
              : dialog.showMessageBox(options);
            dialogPromise
              .then(({ response }) => {
                logInfo("Update download dialog response", { response });
                if (response === 0) {
                  autoUpdater.downloadUpdate().catch((err: unknown) => {
                    logError(
                      "Auto-update download failed",
                      err instanceof Error ? err : new Error(String(err))
                    );
                  });
                }
              })
              .catch((err: unknown) => {
                logError(
                  "Update dialog failed",
                  err instanceof Error ? err : new Error(String(err))
                );
              });
          });

          autoUpdater.on("update-not-available", (info: UpdateInfo) => {
            logInfo("autoUpdater update-not-available", info);
          });

          autoUpdater.on("download-progress", (info) => {
            logInfo("autoUpdater download-progress", {
              percent: info.percent,
              transferred: info.transferred,
              total: info.total,
            });
          });

          autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
            logInfo("autoUpdater update-downloaded", info);
            updateInstallState = markUpdateDownloaded(updateInstallState, info.version);
            mainWindow?.webContents.send("update-downloaded", { version: info.version });
            // mainWindow 可能已被销毁（用户关闭到托盘后退出）；fallback 到无父窗口版本
            // 让用户仍能看到提示，而非抛 "Cannot read properties of null"。
            const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
            const options = {
              type: "info" as const,
              title: "Update Downloaded",
              message: `Version ${info.version} has been downloaded. Restart to install the update.`,
              buttons: ["Restart Now", "Later"],
              defaultId: 0,
            };
            const showPromise = parent
              ? dialog.showMessageBox(parent, options)
              : dialog.showMessageBox(options);
            showPromise
              .then(({ response }) => {
                logInfo("Update restart dialog response", { response });
                if (response === 0) {
                  setQuitting(true);
                  logInfo("Calling autoUpdater.quitAndInstall");
                  autoUpdater.quitAndInstall();
                }
              })
              .catch((err: unknown) => {
                logError(
                  "Update restart dialog failed",
                  err instanceof Error ? err : new Error(String(err))
                );
              });
          });

          autoUpdater.on("error", (err) => {
            logError("autoUpdater error", err);
          });

          void autoUpdater.checkForUpdates().catch((err: unknown) => {
            logError(
              "autoUpdater checkForUpdates failed",
              err instanceof Error ? err : new Error(String(err))
            );
          });
        } catch (err) {
          logError("Auto-update check failed:", err);
        }
      }, 30_000);
    }
  } catch (err) {
    serverState = "stopped";
    cleanup();
    activePort = null;
    const message = err instanceof Error ? err.message : String(err);
    logError("Failed to start:", err);

    if (startupUiReady) {
      showStartupState("error", message);
      return;
    }

    dialog.showErrorBox("启动失败", message);
    app.quit();
  }
});
