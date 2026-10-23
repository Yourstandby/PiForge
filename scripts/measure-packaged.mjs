#!/usr/bin/env node
/**
 * 打包版实测：启动时间线 + 进程内存/CPU（本机、真实数据）。
 *
 * 为什么要独立 userData：单实例锁跟着 userData 走，直接起第二个 PiForge 会立刻退出。
 * 本脚本用临时目录（`PIFORGE_USER_DATA`）起一个干净实例，采完就 kill，
 * 不影响用户正在用的那个窗口。
 *
 *   node scripts/measure-packaged.mjs --exe "release/win-unpacked/PiForge.exe"
 *   node scripts/measure-packaged.mjs --exe ... --seconds 8 --max-host-ready 5000 --max-rss-mb 900
 *
 * 输出：
 *   - `app ready → window / static url loaded / host ready`（读主进程 JSONL 日志）
 *   - 每个进程角色的 RSS（main / renderer / gpu / next-server / agent-host / …）
 *   - 采样窗口内的 CPU%（单核口径）
 *   - 端口检查（30141 必须为空：零内部端口）
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

function parseArgs(argv) {
  const args = {
    exe: null,
    seconds: 8,
    interval: 250,
    json: false,
    keepUserData: false,
    maxHostReady: null,
    maxWindow: null,
    maxRssMb: null,
    /** host（agent-host 角色）单进程 RSS 上限（Step 4 · L1 的验收线）。 */
    maxHostRssMb: null,
    maxIdleCpu: null,
    skipPortCheck: false,
    /** 不等 Host 稳定就直接采样（只看启动耗时用）。 */
    quick: false,
    /** Host 就绪之后先静置多久再采样（默认 2s；稳态测量用 15s）。 */
    settle: 2,
    /** 打印每秒的 CPU 序列（判断"持续占用"还是"一次性尖峰"）。 */
    series: false,
    /** 额外传给可执行文件的参数（dev 模式要传 app 路径）。 */
    extraArgs: [],
    /** 覆盖进程匹配用的 exe 名（dev 模式的宿主是 electron.exe）。 */
    name: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    switch (key) {
      case "--exe":
        args.exe = next;
        i += 1;
        break;
      case "--seconds":
        args.seconds = Number(next);
        i += 1;
        break;
      case "--json":
        args.json = true;
        break;
      case "--keep-user-data":
        args.keepUserData = true;
        break;
      case "--max-host-ready":
        args.maxHostReady = Number(next);
        i += 1;
        break;
      case "--max-window":
        args.maxWindow = Number(next);
        i += 1;
        break;
      case "--max-rss-mb":
        args.maxRssMb = Number(next);
        i += 1;
        break;
      case "--max-host-rss-mb":
        args.maxHostRssMb = Number(next);
        i += 1;
        break;
      case "--max-idle-cpu":
        args.maxIdleCpu = Number(next);
        i += 1;
        break;
      case "--skip-port-check":
        args.skipPortCheck = true;
        break;
      case "--quick":
        args.quick = true;
        break;
      case "--settle":
        args.settle = Number(next);
        i += 1;
        break;
      case "--series":
        args.series = true;
        break;
      case "--arg":
        args.extraArgs.push(next);
        i += 1;
        break;
      case "--name":
        args.name = next;
        i += 1;
        break;
      default:
        if (key.startsWith("-")) {
          console.error(`unknown flag: ${key}`);
          process.exit(2);
        }
    }
  }
  return args;
}

const PS_SNAPSHOT = `
$ErrorActionPreference = 'SilentlyContinue'
$cmd = @{}
Get-CimInstance Win32_Process | ForEach-Object { $cmd[[int]$_.ProcessId] = $_.CommandLine }
Get-Process |
  Select-Object @{n='Id';e={$_.Id}},
                @{n='Name';e={$_.ProcessName}},
                @{n='Rss';e={$_.WorkingSet64}},
                @{n='Cpu';e={ if ($_.TotalProcessorTime) { $_.TotalProcessorTime.TotalSeconds } else { 0 } }},
                @{n='Cmd';e={$cmd[[int]$_.Id]}} |
  ConvertTo-Json -Compress
`;

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    const candidates = ["pwsh", "powershell"];
    const tryNext = (index) => {
      if (index >= candidates.length) {
        reject(new Error("PowerShell (pwsh/powershell) not found"));
        return;
      }
      const child = spawn(
        candidates[index],
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { windowsHide: true },
      );
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk) => (out += chunk.toString()));
      child.stderr.on("data", (chunk) => (err += chunk.toString()));
      child.once("error", () => tryNext(index + 1));
      child.once("close", (code) => {
        if (code === 0) resolve(out);
        else if (index === 0) tryNext(1);
        else reject(new Error(err || `powershell exited ${code}`));
      });
    };
    tryNext(0);
  });
}

/** 按命令行判定角色（Windows 上所有 PiForge 进程同名，只能看 Cmd）。 */
function classify(commandLine) {
  const cmd = String(commandLine ?? "");
  if (/server\.js/i.test(cmd)) return "next-server";
  if (/--type=renderer/.test(cmd)) return "renderer";
  if (/--type=gpu-process/.test(cmd)) return "gpu";
  if (/--type=crashpad/.test(cmd)) return "crashpad";
  if (/utility-sub-type=network\./.test(cmd)) return "network";
  if (/utility-sub-type=audio\./.test(cmd)) return "audio";
  if (/utility-sub-type=node\.mojom\.NodeService/.test(cmd)) return "agent-host";
  if (/--type=utility/.test(cmd)) return "utility";
  if (/--type=/.test(cmd)) return "helper";
  return "main";
}

async function snapshot(exePath) {
  const raw = await runPowerShell(PS_SNAPSHOT);
  const parsed = JSON.parse(raw || "[]");
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const exeName = (args.name ?? path.basename(exePath)).toLowerCase();
  const exeDir = path.dirname(exePath).toLowerCase();
  return rows
    .filter((row) => {
      const name = String(row.Name ?? "").toLowerCase();
      const cmd = String(row.Cmd ?? "").toLowerCase();
      return name === exeName.replace(/\.exe$/, "") || cmd.includes(exeDir);
    })
    .map((row) => ({
      pid: Number(row.Id),
      name: String(row.Name ?? ""),
      role: classify(row.Cmd),
      rss: Number(row.Rss ?? 0),
      cpuSeconds: Number(row.Cpu ?? 0),
    }));
}

function readLogEntries(logPath) {
  if (!existsSync(logPath)) return [];
  const text = readFileSync(logPath, "utf8");
  const entries = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // 半行
    }
  }
  return entries;
}

async function waitForReady(logPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entries = readLogEntries(logPath);
    const ready = entries.find((entry) => String(entry.message ?? "").startsWith("Startup timing: static app url loaded"))
      ?? entries.find((entry) => String(entry.message ?? "").startsWith("Startup timing: loading app url"));
    if (ready) return entries;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return readLogEntries(logPath);
}

const args = parseArgs(process.argv.slice(2));
const exe = args.exe ? path.resolve(args.exe) : null;
if (!exe || !existsSync(exe)) {
  console.error("measure-packaged: --exe <path to PiForge.exe> is required and must exist");
  process.exit(2);
}

const userData = process.env.PIFORGE_USER_DATA?.trim() || mkdtempSync(path.join(tmpdir(), "piforge-measure-"));
const logPath = path.join(userData, "logs", "main.log");
console.log(`measure-packaged: userData=${userData}`);
console.log(`measure-packaged: exe=${exe}`);

const child = spawn(exe, args.extraArgs, {
  env: { ...process.env, PIFORGE_USER_DATA: userData },
  stdio: "ignore",
  detached: false,
});

const startedAt = Date.now();
let exited = false;
child.once("exit", () => {
  exited = true;
});

const cleanup = () => {
  if (exited) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/F", "/T"], { windowsHide: true });
  } else {
    child.kill("SIGKILL");
  }
};

let entries = await waitForReady(logPath, 40_000);
const timeToWindow = Date.now() - startedAt;

/**
 * 再等 Host 就绪：`static app url loaded` 只代表窗口能画了，
 * 内存/CPU 的稳定值要在 Host 加载完之后才有意义（否则会把 Pi SDK 的初始化
 * 峰值当成常驻值）。
 */
{
  const deadline = Date.now() + 40_000;
  for (;;) {
    const found = entries.some(
      (entry) =>
        String(entry.message ?? "") === "Agent Host ready" ||
        String(entry.message ?? "").startsWith("Startup timing: agent host ready"),
    );
    if (found || Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
    entries = readLogEntries(logPath);
  }
  if (!args.quick) await new Promise((resolve) => setTimeout(resolve, args.settle * 1000));
}

/** 时间线：以最后一条 `Startup timing: app ready` 为 0。 */
const appReadyIndex = entries.map((entry) => String(entry.message ?? "")).lastIndexOf("Startup timing: app ready");
const run = appReadyIndex === -1 ? [] : entries.slice(appReadyIndex);
const stages = new Map();
for (const entry of run) {
  const message = String(entry.message ?? "");
  if (message.startsWith("Startup timing: ")) {
    const value = Number(entry.detail?.elapsedMs);
    if (Number.isFinite(value)) stages.set(message.slice("Startup timing: ".length), value);
    continue;
  }
  if (message === "Agent Host ready") {
    const time = Date.parse(String(entry.time ?? ""));
    const ready = Date.parse(String(run[0]?.time ?? ""));
    if (Number.isFinite(time) && Number.isFinite(ready) && !stages.has("agent host ready")) {
      stages.set("agent host ready", time - ready);
    }
  }
}

// ---- 采样内存 / CPU -------------------------------------------------------
const first = await snapshot(exe);
const track = new Map(first.map((row) => [row.pid, { ...row, firstCpu: row.cpuSeconds }]));
const sampleStart = Date.now();
const deadline = sampleStart + args.seconds * 1000;
const series = [];
let lastSeriesAt = sampleStart;
let lastSeriesCpu = new Map(first.map((row) => [row.pid, { role: row.role, cpu: row.cpuSeconds }]));
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, args.interval));
  const rows = await snapshot(exe);
  for (const row of rows) {
    const entry = track.get(row.pid);
    if (entry) {
      entry.rss = row.rss;
      entry.cpuSeconds = row.cpuSeconds;
    } else {
      track.set(row.pid, { ...row, firstCpu: row.cpuSeconds });
    }
  }
  if (args.series && Date.now() - lastSeriesAt >= 1_000) {
    const now = Date.now();
    const seconds = (now - lastSeriesAt) / 1000;
    const byRole = {};
    for (const row of rows) {
      const previous = lastSeriesCpu.get(row.pid);
      const delta = previous ? Math.max(0, row.cpuSeconds - previous.cpu) : 0;
      byRole[row.role] = (byRole[row.role] ?? 0) + (delta / seconds) * 100;
    }
    series.push({ t: ((now - sampleStart) / 1000).toFixed(0), byRole });
    lastSeriesAt = now;
    lastSeriesCpu = new Map(rows.map((row) => [row.pid, { role: row.role, cpu: row.cpuSeconds }]));
  }
}
const windowSeconds = Math.max(0.25, (Date.now() - sampleStart) / 1000);

const rows = [...track.values()].map((entry) => ({
  pid: entry.pid,
  role: entry.role,
  rssMb: Number((entry.rss / (1024 * 1024)).toFixed(1)),
  cpuPercent: Number((((entry.cpuSeconds - entry.firstCpu) / windowSeconds) * 100).toFixed(2)),
}));

const byRole = new Map();
for (const row of rows) {
  const entry = byRole.get(row.role) ?? { role: row.role, count: 0, rssMb: 0, cpuPercent: 0 };
  entry.count += 1;
  entry.rssMb += row.rssMb;
  entry.cpuPercent += row.cpuPercent;
  byRole.set(row.role, entry);
}

const totalRssMb = Number(rows.reduce((sum, row) => sum + row.rssMb, 0).toFixed(1));
const totalCpu = Number(rows.reduce((sum, row) => sum + row.cpuPercent, 0).toFixed(2));

// ---- 端口检查（零内部端口）------------------------------------------------
let portOpen = null;
if (!args.skipPortCheck && process.platform === "win32") {
  const netstat = spawnSync("netstat.exe", ["-ano", "-p", "TCP"], { windowsHide: true });
  const pids = new Set(rows.map((row) => String(row.pid)));
  const lines = netstat.stdout?.toString().split("\n") ?? [];
  portOpen = lines.some(
    (line) => /:30141\s/.test(line) && line.trim().split(/\s+/).some((part) => pids.has(part)),
  );
}

cleanup();
if (!args.keepUserData && !process.env.PIFORGE_USER_DATA) {
  setTimeout(() => rmSync(userData, { recursive: true, force: true }), 500);
}

const report = {
  exe,
  processCount: rows.length,
  timelineMs: Object.fromEntries(
    ["window created", "loading static app url", "static app url loaded", "host ready", "agent host ready", "loading app url", "next server ready"]
      .filter((stage) => stages.has(stage))
      .map((stage) => [stage, stages.get(stage)]),
  ),
  spawnToWindowMs: timeToWindow,
  sampledSeconds: Number(windowSeconds.toFixed(2)),
  totalRssMb,
  totalCpuPercentSingleCore: totalCpu,
  hasNextServerProcess: rows.some((row) => row.role === "next-server"),
  hostRssMb: Number((byRole.get("agent-host")?.rssMb ?? 0).toFixed(1)),
  hostCpuPercent: Number((byRole.get("agent-host")?.cpuPercent ?? 0).toFixed(2)),
  internalPortOpen: portOpen,
  byRole: [...byRole.values()]
    .map((entry) => ({
      ...entry,
      rssMb: Number(entry.rssMb.toFixed(1)),
      cpuPercent: Number(entry.cpuPercent.toFixed(2)),
    }))
    .sort((a, b) => b.rssMb - a.rssMb),
  processes: rows.sort((a, b) => b.rssMb - a.rssMb),
  series,
};

const failures = [];
const hostReady = report.timelineMs["agent host ready"] ?? null;
if (hostReady === null) failures.push("没有 host ready（Host 未就绪）");
else if (args.maxHostReady !== null && hostReady > args.maxHostReady) {
  failures.push(`host ready ${hostReady}ms > ${args.maxHostReady}ms`);
}
const windowMs = report.timelineMs["window created"] ?? null;
if (args.maxWindow !== null && windowMs !== null && windowMs > args.maxWindow) {
  failures.push(`window created ${windowMs}ms > ${args.maxWindow}ms`);
}
if (args.maxRssMb !== null && totalRssMb > args.maxRssMb) {
  failures.push(`总 RSS ${totalRssMb} MB > ${args.maxRssMb} MB`);
}
if (args.maxHostRssMb !== null && report.hostRssMb > args.maxHostRssMb) {
  failures.push(`host RSS ${report.hostRssMb} MB > ${args.maxHostRssMb} MB`);
}
if (args.maxIdleCpu !== null && totalCpu > args.maxIdleCpu) {
  failures.push(`空闲 CPU ${totalCpu}%（单核口径）> ${args.maxIdleCpu}%`);
}
if (report.hasNextServerProcess) failures.push("仍有 next-server 进程（P1-4 未生效）");
if (portOpen === true) failures.push("30141 端口仍被本应用占用（违反零内部端口）");

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log("");
  console.log("启动时间线（ms，相对 app ready）：");
  for (const [stage, value] of Object.entries(report.timelineMs)) {
    console.log(`  ${stage.padEnd(28)} ${String(value).padStart(6)}`);
  }
  console.log(`  ${"spawn → 窗口就绪(实测)".padEnd(28)} ${String(report.spawnToWindowMs).padStart(6)}`);
  console.log("");
  console.log(
    `host ${report.hostRssMb} MB · 内存 ${report.totalRssMb} MB / ${report.processCount} 进程 · CPU ${report.totalCpuPercentSingleCore}%（单核口径，采样 ${report.sampledSeconds}s） · next-server=${report.hasNextServerProcess} · 30141=${report.internalPortOpen}`,
  );
  console.log("");
  if (series.length > 0) {
    console.log("");
    console.log("每秒 CPU%（按角色）：");
    for (const point of series) {
      const parts = Object.entries(point.byRole)
        .filter(([, value]) => value >= 0.05)
        .map(([role, value]) => `${role}=${value.toFixed(1)}`)
        .join(" ");
      console.log(`  +${point.t.padStart(2)}s  ${parts || "~0"}`);
    }
  }
  console.log("");
  console.log("角色                     数量    RSS(MB)    CPU%");
  for (const entry of report.byRole) {
    console.log(
      `${entry.role.padEnd(22)} ${String(entry.count).padStart(3)}  ${String(entry.rssMb).padStart(9)}  ${String(entry.cpuPercent).padStart(6)}`,
    );
  }
}

if (failures.length > 0) {
  console.error("");
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
process.exit(0);
