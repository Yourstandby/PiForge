#!/usr/bin/env node
/**
 * PiForge 进程实测采样器（本机、真实数据，不接受估算）。
 *
 * 一个命令同时产出三份基线需要的东西：
 *   1. 进程数 + RSS 求和（MB，Windows 用 WorkingSet64）；
 *   2. 每进程在采样窗口内实际消耗的 CPU%（TotalProcessorTime 差值 / 墙钟）；
 *   3. 按进程名分组的小计（PiForge 主进程 / 各 renderer / Next server / agent-host）。
 *
 * 用法：
 *   node scripts/measure-app-processes.mjs                    # 采 8 秒，人类可读
 *   node scripts/measure-app-processes.mjs --seconds 10 --json
 *   node scripts/measure-app-processes.mjs --max-rss-mb 1000 --max-idle-cpu 5
 *
 * 验收用（任一条超阈值即 exit 1）：
 *   --max-rss-mb <n>     总 RSS 上限
 *   --max-idle-cpu <n>   采样窗口内总 CPU% 上限（单核口径：1 核跑满 = 100%）
 *
 * CPU% 用 TotalProcessorTime 差值算，和任务管理器同一口径；n 核机器的理论上限
 * 是 n*100。空闲基线要的正是"单核百分比接近 0"。
 */
import { execFile } from "node:child_process";
import process from "node:process";

function parseArgs(argv) {
  const args = {
    seconds: 8,
    interval: 250,
    json: false,
    match: null,
    maxRssMb: null,
    maxIdleCpu: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    switch (key) {
      case "--seconds":
        args.seconds = Number(next);
        i += 1;
        break;
      case "--interval":
        args.interval = Number(next);
        i += 1;
        break;
      case "--json":
        args.json = true;
        break;
      case "--match":
        args.match = next;
        i += 1;
        break;
      case "--max-rss-mb":
        args.maxRssMb = Number(next);
        i += 1;
        break;
      case "--max-idle-cpu":
        args.maxIdleCpu = Number(next);
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

/**
 * 从命令行推断进程角色 —— 这是对比报告里"renderer 470MB / Next 385MB / agent-host 193MB"
 * 这三条能不能直接对上的前提（Windows 上它们全都叫 PiForge.exe）。
 */
function classify(commandLine, name) {
  const cmd = String(commandLine ?? "");
  void name;
  // Next standalone server：Windows 上是 ELECTRON_RUN_AS_NODE 的 PiForge.exe + server.js。
  if (/server\.js/i.test(cmd)) return "next-server";
  if (/--type=renderer/.test(cmd)) return "renderer";
  if (/--type=gpu-process/.test(cmd)) return "gpu";
  if (/utility-sub-type=network\./.test(cmd)) return "network";
  if (/utility-sub-type=audio\./.test(cmd)) return "audio";
  // agent-host 走 utilityProcess.fork → node.mojom.NodeService。
  if (/utility-sub-type=node\.mojom\.NodeService/.test(cmd)) return "agent-host";
  if (/--type=utility/.test(cmd)) return "utility";
  if (/--type=/.test(cmd)) return "helper";
  return "main";
}

/** pwsh 7 优先，回退 Windows PowerShell 5.1（项目 PowerShell 一等公民约定）。 */
function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    const candidates = ["pwsh", "powershell"];
    const tryNext = (index) => {
      if (index >= candidates.length) {
        reject(new Error("PowerShell (pwsh/powershell) not found"));
        return;
      }
      execFile(
        candidates[index],
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { maxBuffer: 8 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          if (error) {
            if (index === 0) tryNext(1);
            else reject(new Error(stderr || error.message));
            return;
          }
          resolve(stdout);
        },
      );
    };
    tryNext(0);
  });
}

/** 非 Windows 兜底：ps 的 time 列转成累计 CPU 秒。 */
function unixSnapshot() {
  return new Promise((resolve, reject) => {
    execFile("ps", ["-eo", "pid=,comm=,rss=,time="], { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      const rows = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const parts = line.split(/\s+/);
          const cpuClock = parts[3] ?? "0:00.00";
          const [minutes, seconds] = cpuClock.split(":");
          return {
            Id: Number(parts[0]),
            Name: (parts[1] ?? "").split("/").pop() ?? "",
            Rss: Number(parts[2] ?? 0) * 1024,
            Cpu: Number(minutes) * 60 + Number(seconds ?? 0),
          };
        });
      resolve(rows);
    });
  });
}

async function snapshot() {
  if (process.platform !== "win32") return unixSnapshot();
  const raw = await runPowerShell(PS_SNAPSHOT);
  const parsed = JSON.parse(raw || "[]");
  return Array.isArray(parsed) ? parsed : [parsed];
}

const args = parseArgs(process.argv.slice(2));
/** 默认只看 PiForge / electron（dev 模式下宿主进程名是 electron）。 */
const matcher = args.match ? new RegExp(args.match) : /^(PiForge|electron)/i;

/** pid → 首次/最近的时间点观测。 */
const track = new Map();

function absorb(rows, at) {
  for (const row of rows) {
    if (!matcher.test(String(row.Name ?? ""))) continue;
    const pid = Number(row.Id);
    const entry = track.get(pid) ?? {
      pid,
      name: String(row.Name ?? ""),
      role: classify(row.Cmd, row.Name),
      firstCpu: Number(row.Cpu ?? 0),
      lastCpu: Number(row.Cpu ?? 0),
      rss: Number(row.Rss ?? 0),
      firstSeen: at,
    };
    entry.lastCpu = Number(row.Cpu ?? 0);
    entry.rss = Number(row.Rss ?? 0);
    entry.name = String(row.Name ?? entry.name);
    entry.role = classify(row.Cmd, row.Name) || entry.role;
    track.set(pid, entry);
  }
}

const startedAt = Date.now();
// 采样期间新出现的进程（Host 重启 / 新窗口）也要计入，否则测出来的 CPU 偏低。
absorb(
  await snapshot().catch((error) => {
    console.error(`measure-app-processes: ${error.message}`);
    process.exit(2);
  }),
  startedAt,
);
if (track.size === 0) {
  console.error(
    `measure-app-processes: 没找到匹配 ${matcher} 的进程。先启动 PiForge 再跑本脚本。`,
  );
  process.exit(2);
}

const deadline = startedAt + args.seconds * 1000;
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, Math.min(args.interval, deadline - Date.now())));
  absorb(await snapshot(), Date.now());
}

const windowSeconds = Math.max(0.25, (Date.now() - startedAt) / 1000);
const rows = [...track.values()].map((entry) => {
  // 新进程只按它参与的窗口计，避免把 CPU 摊薄。
  const aliveSeconds = Math.max(
    0.25,
    (Date.now() - Math.max(startedAt, entry.firstSeen)) / 1000,
  );
  return {
    pid: entry.pid,
    name: entry.name,
    role: entry.role,
    rssMb: Number((entry.rss / (1024 * 1024)).toFixed(1)),
    cpuPercent: Number(Math.max(0, ((entry.lastCpu - entry.firstCpu) / aliveSeconds) * 100).toFixed(1)),
  };
});

const byName = new Map();
for (const row of rows) {
  // 按角色聚合：对比报告里的 renderer / next-server / agent-host 就是这三行。
  const key = row.role;
  const entry = byName.get(key) ?? { name: key, count: 0, rssMb: 0, cpuPercent: 0 };
  entry.count += 1;
  entry.rssMb += row.rssMb;
  entry.cpuPercent += row.cpuPercent;
  byName.set(key, entry);
}

const report = {
  sampledAt: new Date().toISOString(),
  windowSeconds: Number(windowSeconds.toFixed(2)),
  processCount: rows.length,
  totalRssMb: Number(rows.reduce((sum, row) => sum + row.rssMb, 0).toFixed(1)),
  totalCpuPercentSingleCore: Number(
    rows.reduce((sum, row) => sum + row.cpuPercent, 0).toFixed(1),
  ),
  byName: [...byName.values()]
    .map((entry) => ({
      ...entry,
      rssMb: Number(entry.rssMb.toFixed(1)),
      cpuPercent: Number(entry.cpuPercent.toFixed(1)),
    }))
    .sort((a, b) => b.rssMb - a.rssMb),
  processes: rows.sort((a, b) => b.cpuPercent - a.cpuPercent),
};

const failures = [];
if (args.maxRssMb !== null && report.totalRssMb > args.maxRssMb) {
  failures.push(`总 RSS ${report.totalRssMb} MB > 上限 ${args.maxRssMb} MB`);
}
if (args.maxIdleCpu !== null && report.totalCpuPercentSingleCore > args.maxIdleCpu) {
  failures.push(`CPU ${report.totalCpuPercentSingleCore}%（单核口径）> 上限 ${args.maxIdleCpu}%`);
}

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(
    `采样窗口 ${report.windowSeconds}s · ${report.processCount} 个进程 · ` +
      `总 RSS ${report.totalRssMb} MB · 总 CPU ${report.totalCpuPercentSingleCore}%（单核口径）`,
  );
  console.log("");
  console.log("进程角色                   数量    RSS(MB)    CPU%");
  for (const entry of report.byName) {
    console.log(
      `${entry.name.padEnd(26)} ${String(entry.count).padStart(3)}  ${String(entry.rssMb).padStart(9)}  ${String(entry.cpuPercent).padStart(6)}`,
    );
  }
  console.log("");
  console.log("按 CPU 排序的明细（前 10）：");
  for (const row of report.processes.slice(0, 10)) {
    console.log(
      `  pid ${String(row.pid).padEnd(7)} ${row.role.padEnd(14)} ${row.name.padEnd(10)} ${String(row.rssMb).padStart(9)} MB  ${String(row.cpuPercent).padStart(6)}%`,
    );
  }
}

if (failures.length > 0) {
  console.error("");
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
