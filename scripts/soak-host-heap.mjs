#!/usr/bin/env node
/**
 * L1（V8 堆参数收紧）的 soak：连续起停 + 真实会话，逐轮记录 host 的
 * 稳态 RSS / CPU，并检查 OOM 证据。
 *
 *   node scripts/soak-host-heap.mjs                    # 15 起停 + 15 真实会话
 *   node scripts/soak-host-heap.mjs --rounds 3 --session-rounds 3
 *   node scripts/soak-host-heap.mjs --json > soak.json
 *
 * 实现方式：每轮调用**已经验证过**的 `scripts/measure-packaged.mjs`
 * （它负责起隔离实例、按角色采样、断言无 next-server），这里只做
 * 「循环 + 聚合 + OOM 检查」—— soak 与日常验收用同一套采样逻辑，
 * 不会出现"soak 自己算的 CPU/RSS 和 measure-packaged 不一致"。
 *
 * 判定（任一不满足即 exit 1）：
 *   - 每轮都拿到 host 采样（`hostRssMb > 0`）；
 *   - 不出现 `<userData>/host-oom.json`（OOM 取证由 agent-host/index.ts 写）；
 *   - host RSS 最大值 ≤ --max-host-rss-mb；
 *   - host 空闲 CPU 中位 ≤ --max-cpu。
 *
 * 「真实会话」轮：`PIFORGE_OPEN_PATH=/?session=<真实 id>` 打开本机最大的会话文件
 * （加载真实 transcript / 工具输出），**不调用模型**（不花 token）。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : Number(args[index + 1]);
};
const exeIndex = args.indexOf("--exe");
const exe = path.resolve(
  exeIndex === -1
    ? process.platform === "win32"
      ? "release/win-unpacked/PiForge.exe"
      : "release/linux-unpacked/piforge"
    : args[exeIndex + 1],
);
const rounds = opt("--rounds", 15);
const sessionRounds = opt("--session-rounds", 15);
const sampleSeconds = opt("--seconds", 8);
const settleSeconds = opt("--settle", 15);
const maxHostRssMb = opt("--max-host-rss-mb", 280);
/** 峰值门禁：不传 = 中位 × 1.15（单轮 GC 抖动不该把整份 soak 判红）。 */
const maxHostRssPeakMb = Number(opt("--max-host-rss-peak", maxHostRssMb * 1.15));
const maxCpu = opt("--max-cpu", 2);
const asJson = args.includes("--json");
const keepUserData = args.includes("--keep-user-data");
/** `--env K=V`（可重复）：透传给每次启动。 */
const extraEnv = {};
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--env" && args[i + 1]) {
    const [key, ...rest] = args[i + 1].split("=");
    extraEnv[key] = rest.join("=");
  }
}

if (!existsSync(exe)) {
  console.error(`soak-host-heap: 缺少可执行文件 ${exe}（先 npm run pack）`);
  process.exit(1);
}

/** 本机最大的真实会话（加载成本最高、最有代表性）。 */
function pickRealSession() {
  const root = path.join(homedir(), ".pi", "agent", "sessions");
  const found = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".jsonl")) {
        try {
          found.push({ file: full, size: statSync(full).size });
        } catch {
          // 忽略读不到的文件
        }
      }
    }
  };
  walk(root);
  found.sort((b, a) => a.size - b.size);
  const match = /_([0-9a-f-]{36})\.jsonl$/.exec(found[0]?.file ?? "");
  return match ? { id: match[1], sizeMb: Math.round((found[0].size / 1048576) * 10) / 10 } : null;
}

function runMeasure(env) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        "scripts/measure-packaged.mjs",
        "--exe",
        exe,
        "--json",
        "--seconds",
        String(sampleSeconds),
        "--settle",
        String(settleSeconds),
      ],
      { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk.toString()));
    child.stderr.on("data", (chunk) => (err += chunk.toString()));
    child.once("exit", () => {
      const start = out.indexOf("{");
      const end = out.lastIndexOf("}");
      if (start === -1 || end === -1) {
        resolve({ ok: false, raw: `${out}\n${err}`.slice(-600) });
        return;
      }
      try {
        resolve({ ok: true, report: JSON.parse(out.slice(start, end + 1)) });
      } catch {
        resolve({ ok: false, raw: out.slice(-600) });
      }
    });
  });
}

const session = pickRealSession();
if (sessionRounds > 0 && !session) {
  console.warn("soak-host-heap: 没找到真实会话文件，真实会话轮退化为普通轮");
}
const userData = mkdtempSync(path.join(tmpdir(), "piforge-soak-"));
const oomFile = path.join(userData, "host-oom.json");

/**
 * 预检：机器上不能有别的 PiForge 在跑。
 *
 * 踩过的坑：另一个实例（用户窗口 / 上一轮的残留 / 并发的测量脚本）会让每轮的
 * RSS 与 CPU 都偏高 —— 实测同样参数下从 157–221 MB 漂到 234–255 MB，
 * 直接把 0.5% 的 CPU 门禁顶穿。宁可拒绝启动，也不要产出一份不可信的数据。
 */
function assertMachineQuiet() {
  const script =
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'PiForge.exe' -or $_.Name -eq 'electron.exe' } | " +
    "Select-Object -ExpandProperty ProcessId";
  const out = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  });
  const lines = String(out.stdout ?? "").split(String.fromCharCode(10));
  const pids = [];
  for (const line of lines) {
    const pid = Number(line.trim());
    if (Number.isFinite(pid) && pid > 0) pids.push(pid);
  }
  if (pids.length > 0) {
    console.error(
      `soak-host-heap: 机器上还有 ${pids.length} 个 PiForge/electron 进程（${pids.slice(0, 6).join(", ")}）。` +
        " 先关掉它们再跑，否则 RSS/CPU 会被污染（预检失败，未开始）。",
    );
    process.exit(2);
  }
}

assertMachineQuiet();

console.log(`soak-host-heap: exe=${exe}`);
console.log(`soak-host-heap: userData=${userData}`);
console.log(
  `soak-host-heap: ${rounds} 起停 + ${sessionRounds} 真实会话（session=${session?.id?.slice(0, 8) ?? "n/a"} ${session?.sizeMb ?? 0} MB）` +
    `，每轮 settle ${settleSeconds}s + 采样 ${sampleSeconds}s，env=${JSON.stringify(extraEnv)}`,
);

const results = [];
const plan = [
  ...Array.from({ length: rounds }, (_, index) => ({ round: index + 1, kind: "boot" })),
  ...Array.from({ length: sessionRounds }, (_, index) => ({ round: rounds + index + 1, kind: "session" })),
];

for (const step of plan) {
  const env = {
    ...extraEnv,
    PIFORGE_USER_DATA: userData,
    ...(step.kind === "session" && session ? { PIFORGE_OPEN_PATH: `/?session=${session.id}` } : {}),
  };
  const outcome = await runMeasure(env);
  if (!outcome.ok) {
    results.push({ ...step, failed: true, error: outcome.raw });
  } else {
    results.push({
      ...step,
      failed: false,
      hostRssMb: outcome.report.hostRssMb ?? 0,
      hostCpuPercent: outcome.report.hostCpuPercent ?? 0,
      totalRssMb: outcome.report.totalRssMb ?? 0,
      hostReadyMs: outcome.report.timelineMs?.["agent host ready"] ?? null,
    });
  }
  const last = results.at(-1);
  console.log(
    `  #${String(step.round).padStart(2)} ${step.kind.padEnd(7)} ` +
      (last.failed
        ? `✗ 采样失败 ${String(last.error).slice(-160)}`
        : `hostRss=${String(last.hostRssMb).padStart(4)}MB cpu=${String(last.hostCpuPercent).padStart(5)}% ready=${last.hostReadyMs ?? "-"}ms`),
  );
}

const oomRecords = existsSync(oomFile)
  ? readFileSync(oomFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { parseError: true, line };
        }
      })
  : [];

const okRounds = results.filter((row) => !row.failed);
const rssValues = okRounds.map((row) => row.hostRssMb).sort((a, b) => a - b);
const cpuValues = okRounds.map((row) => row.hostCpuPercent).sort((a, b) => a - b);
const median = (values) => (values.length === 0 ? 0 : values[Math.floor(values.length / 2)]);

const payload = {
  generatedAt: new Date().toISOString(),
  config: {
    rounds,
    sessionRounds,
    sampleSeconds,
    settleSeconds,
    maxHostRssMb,
    maxCpu,
    env: extraEnv,
    session: session?.id ?? null,
  },
  summary: {
    rounds: results.length,
    okRounds: okRounds.length,
    /** 真实峰值（不是最后一轮的值）。 */
    hostRssMax: rssValues.length > 0 ? Math.max(...rssValues) : 0,
    hostRssMedian: median(rssValues),
    hostCpuMedian: median(cpuValues),
    oomEvents: oomRecords.length,
  },
  rounds: results,
  oom: oomRecords,
};

if (!keepUserData) setTimeout(() => rmSync(userData, { recursive: true, force: true }), 500);

const failures = [];
if (okRounds.length !== results.length) failures.push(`${results.length - okRounds.length} 轮采样失败`);
if (payload.summary.oomEvents > 0) failures.push(`出现 ${payload.summary.oomEvents} 次 OOM`);
/**
 * 门禁口径（与验收文档一致）：
 *   - **中位** `--max-host-rss-mb`：稳态验收线；
 *   - **峰值** `--max-host-rss-peak`：默认 = 中位 × 1.15，只用于发现失控（单轮尖峰不算失败）。
 * 之前把"最大值"当中位门禁，会让一次 GC 抖动把整份 soak 判红。
 */
if (payload.summary.hostRssMedian > maxHostRssMb) {
  failures.push(`host RSS 中位 ${payload.summary.hostRssMedian} MB > ${maxHostRssMb} MB`);
}
const peakLimit = Math.round(maxHostRssPeakMb);
if (payload.summary.hostRssMax > peakLimit) {
  failures.push(`host RSS 峰值 ${payload.summary.hostRssMax} MB > ${peakLimit} MB（峰值门禁）`);
}
if (payload.summary.hostCpuMedian > maxCpu) {
  failures.push(`host 空闲 CPU 中位 ${payload.summary.hostCpuMedian}% > ${maxCpu}%`);
}

if (asJson) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log("");
  console.log(
    `汇总：${okRounds.length}/${results.length} 轮有效 · host RSS 中位 ${payload.summary.hostRssMedian} MB / 最大 ${payload.summary.hostRssMax} MB · ` +
      `空闲 CPU 中位 ${payload.summary.hostCpuMedian}% · OOM ${payload.summary.oomEvents} 次`,
  );
  if (payload.summary.oomEvents > 0) {
    for (const record of oomRecords) {
      console.log(`  OOM: ${record.at} ${record.source} ${String(record.message ?? "").slice(0, 120)}`);
    }
  }
}

if (failures.length > 0) {
  console.error("");
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
console.log("\nsoak-host-heap: PASS");
