/**
 * GPU 进程策略（B 项：gpu RSS 230–259 MB 的归因与收敛）。
 *
 * 实测结论（本机，Electron 43.8.3 / Chromium 150.0.7871.250）：
 *   - `app.getGPUFeatureStatus()` 显示 `gpu_compositing: "disabled_software"`、
 *     `opengl: "disabled_off"` —— 这台机器的硬件加速**根本不可用**（远程会话 /
 *     blocklist 都会这样），合成本来就在软件路径上；
 *   - 既然硬件加速不可用，GPU 进程仍在枚举 GL/Vulkan、初始化 ANGLE 与 shader cache，
 *     白白占 ~100 MB（实测 gpu 254.7 MB → `--disable-gpu` 155.7 MB，
 *     renderer 129.7 → 160.8，总量 951.5 → 875.5 MB，空闲 CPU 1.08% → 0.55%）；
 *   - 硬件加速可用的机器上 `--disable-gpu` 是**有害的**（强制软件合成，滚动掉帧），
 *     所以这里只允许"上一轮已经观察到软件合成"时才切。
 *
 * 因此策略是**自适应**，不是写死开关：
 *   1. 每次启动记录 `getGPUFeatureStatus().gpu_compositing`；
 *   2. 连续 2 次观察到 `disabled_software` 才在本轮启动前加 `--disable-gpu`；
 *   3. 证据 30 天后过期（换机器 / 换会话类型能自愈）；
 *   4. `PIFORGE_GPU_MODE=default|nogpu|inprocess` 可强制覆盖（实验/排障用）。
 *
 * 纯函数 + 窄接口：不 import Electron，便于单测。
 */

export type GpuMode = "default" | "nogpu" | "inprocess";

export interface GpuEvidence {
  version: 1;
  /** 连续观察到"软件合成"的次数。 */
  softwareLaunches: number;
  /** 最近一次观测到的 `gpu_compositing` 原始值。 */
  lastGpuCompositing: string | null;
  /** 记录时间（epoch ms），用于过期自愈。 */
  recordedAt: number;
}

export const GPU_EVIDENCE_FILE = "gpu-evidence.json";
/** 连续多少次软件合成才认为"这台机器不需要 GPU 进程"。 */
export const SOFTWARE_LAUNCHES_THRESHOLD = 2;
/** 证据有效期：过期后重新按 default 跑一次，避免换机器后一直不开硬件加速。 */
export const EVIDENCE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function emptyEvidence(): GpuEvidence {
  return { version: 1, softwareLaunches: 0, lastGpuCompositing: null, recordedAt: 0 };
}

/** `gpu_compositing` 的取值里，这两个前缀都表示"硬件合成没生效"。 */
export function isSoftwareCompositing(status: unknown): boolean {
  if (typeof status !== "string") return false;
  return status === "disabled_software" || status.startsWith("unavailable_software");
}

export interface GpuDecisionInput {
  evidence: GpuEvidence | null;
  env?: Record<string, string | undefined>;
  now?: number;
}

export interface GpuDecision {
  mode: GpuMode;
  /** 决策依据，写进日志便于事后核对（不要只留一个布尔）。 */
  reason: string;
  /** 需要追加的 Chromium switch（空数组 = 不动默认行为）。 */
  switches: string[];
}

/**
 * 决定本轮启动是否避开 GPU 进程。
 *
 * `nogpu` = `--disable-gpu`（不初始化 GL/ANGLE，实测 gpu 进程 ~155 MB）；
 * `inprocess` = `--in-process-gpu`（GPU 进程整体消失，4 个进程）。
 */
export function resolveGpuMode(input: GpuDecisionInput): GpuDecision {
  const now = input.now ?? Date.now();
  const forced = input.env?.PIFORGE_GPU_MODE?.trim().toLowerCase();
  if (forced === "default") {
    return { mode: "default", reason: "PIFORGE_GPU_MODE=default（强制默认）", switches: [] };
  }
  if (forced === "nogpu") {
    return { mode: "nogpu", reason: "PIFORGE_GPU_MODE=nogpu（强制）", switches: ["disable-gpu"] };
  }
  if (forced === "inprocess") {
    return { mode: "inprocess", reason: "PIFORGE_GPU_MODE=inprocess（强制）", switches: ["in-process-gpu"] };
  }

  const evidence = input.evidence;
  if (!evidence) {
    return { mode: "default", reason: "没有上一轮的 GPU 证据（首次启动）", switches: [] };
  }
  if (now - evidence.recordedAt > EVIDENCE_TTL_MS) {
    return { mode: "default", reason: "GPU 证据已过期（>30 天），重新探测", switches: [] };
  }
  if (evidence.softwareLaunches < SOFTWARE_LAUNCHES_THRESHOLD) {
    return {
      mode: "default",
      reason: `连续软件合成 ${evidence.softwareLaunches}/${SOFTWARE_LAUNCHES_THRESHOLD} 次，继续观察`,
      switches: [],
    };
  }
  return {
    mode: "nogpu",
    reason: `连续 ${evidence.softwareLaunches} 次观察到软件合成（${evidence.lastGpuCompositing ?? "unknown"}），本轮不初始化 GPU 进程`,
    switches: ["disable-gpu"],
  };
}

/**
 * 用本轮观测到的 `gpu_compositing` 更新证据。
 *
 * - 软件合成 → 计数 +1（上限阈值，避免无限增长）；
 * - 硬件合成 → 清零（机器/会话变好了，下一轮恢复默认）。
 */
export function recordGpuObservation(
  previous: GpuEvidence | null,
  observedCompositing: unknown,
  now: number = Date.now(),
): GpuEvidence {
  const base = previous ?? emptyEvidence();
  const software = isSoftwareCompositing(observedCompositing);
  return {
    version: 1,
    softwareLaunches: software
      ? Math.min(SOFTWARE_LAUNCHES_THRESHOLD, base.softwareLaunches + 1)
      : 0,
    lastGpuCompositing: typeof observedCompositing === "string" ? observedCompositing : null,
    recordedAt: now,
  };
}

/** 解析磁盘上的证据文件；损坏/版本不符一律当作"没有证据"。 */
export function parseGpuEvidence(raw: string | null | undefined): GpuEvidence | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<GpuEvidence>;
    if (parsed?.version !== 1) return null;
    if (typeof parsed.softwareLaunches !== "number" || !Number.isFinite(parsed.softwareLaunches)) return null;
    return {
      version: 1,
      softwareLaunches: Math.max(0, Math.min(SOFTWARE_LAUNCHES_THRESHOLD, Math.floor(parsed.softwareLaunches))),
      lastGpuCompositing: typeof parsed.lastGpuCompositing === "string" ? parsed.lastGpuCompositing : null,
      recordedAt: typeof parsed.recordedAt === "number" && Number.isFinite(parsed.recordedAt) ? parsed.recordedAt : 0,
    };
  } catch {
    return null;
  }
}
