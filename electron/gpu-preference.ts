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
 *   1. 每次启动记录 `getGPUFeatureStatus()` 快照 + 探测时间；
 *   2. 连续 2 次观察到 `disabled_software` 才在本轮启动前加 `--disable-gpu`；
 *   3. 证据 30 天后过期（换机器 / 换会话类型能自愈），过期只看不切；
 *   4. `PIFORGE_GPU_MODE=default|nogpu|inprocess` 可强制覆盖（实验/排障用）。
 *
 * 可观测性（本轮补）：证据文件带 `probedAt` / `gpuFeatureStatus` / `decision`，
 * 且**决策发生变化时**在日志里打一行
 * `gpu mode re-evaluated: <prev>→<next>, reason=<code>`
 * —— 30 天过期重探属于"用户不可见但要能 grep 到"的行为，必须留下痕迹。
 *
 * 纯函数 + 窄接口：不 import Electron，便于单测。
 */

export type GpuMode = "default" | "nogpu" | "inprocess";

/** 机器可读的决策依据（日志与证据文件里用同一套枚举）。 */
export type GpuDecisionCode =
  /** 没有历史证据（首次启动 / 证据文件损坏）。 */
  | "no_evidence"
  /** 连续软件合成计数还没到阈值。 */
  | "observing"
  /** 连续 N 次软件合成 → 本轮不初始化 GPU 进程。 */
  | "consecutive_software"
  /** 观测到硬件合成（计数已清零）。 */
  | "hardware_ok"
  /** 证据超过 30 天 → 重新按默认探测。 */
  | "expired"
  /** `PIFORGE_GPU_MODE` 强制指定。 */
  | "force_override";

export interface GpuEvidence {
  version: 2;
  /** 连续观察到"软件合成"的次数。 */
  softwareLaunches: number;
  /** 最近一次观测到的 `gpu_compositing` 原始值。 */
  lastGpuCompositing: string | null;
  /** 本次探测时间（epoch ms）。 */
  probedAt: number;
  /** `app.getGPUFeatureStatus()` 的完整快照（跨机器对齐时的事实来源）。 */
  gpuFeatureStatus: Record<string, string> | null;
  /** 上一轮做出的决策（用于产生 "re-evaluated" 日志与排障）。 */
  decision: { mode: GpuMode; code: GpuDecisionCode } | null;
}

export const GPU_EVIDENCE_FILE = "gpu-evidence.json";
/** 连续多少次软件合成才认为"这台机器不需要 GPU 进程"。 */
export const SOFTWARE_LAUNCHES_THRESHOLD = 2;
/** 证据有效期：过期后重新按 default 跑一次，避免换机器后一直不开硬件加速。 */
export const EVIDENCE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function emptyEvidence(): GpuEvidence {
  return {
    version: 2,
    softwareLaunches: 0,
    lastGpuCompositing: null,
    probedAt: 0,
    gpuFeatureStatus: null,
    decision: null,
  };
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
  /** 机器可读依据（写进证据文件与日志）。 */
  code: GpuDecisionCode;
  /** 人类可读依据，写进日志便于事后核对（不要只留一个布尔）。 */
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
  if (forced === "default" || forced === "nogpu" || forced === "inprocess") {
    return {
      mode: forced,
      code: "force_override",
      reason: `PIFORGE_GPU_MODE=${forced}（强制覆盖自适应）`,
      switches: forced === "nogpu" ? ["disable-gpu"] : forced === "inprocess" ? ["in-process-gpu"] : [],
    };
  }

  const evidence = input.evidence;
  if (!evidence) {
    return { mode: "default", code: "no_evidence", reason: "没有上一轮的 GPU 证据（首次启动）", switches: [] };
  }
  if (now - evidence.probedAt > EVIDENCE_TTL_MS) {
    return {
      mode: "default",
      code: "expired",
      reason: `GPU 证据已过期（>${Math.round(EVIDENCE_TTL_MS / 86_400_000)} 天），重新探测`,
      switches: [],
    };
  }
  if (!isSoftwareCompositing(evidence.lastGpuCompositing)) {
    // 证据自相矛盾（计数够但上次其实是硬件合成）：按硬件正常处理。
    return {
      mode: "default",
      code: "hardware_ok",
      reason: `上一轮观测到 ${evidence.lastGpuCompositing ?? "unknown"}（非软件合成）`,
      switches: [],
    };
  }
  if (evidence.softwareLaunches < SOFTWARE_LAUNCHES_THRESHOLD) {
    return {
      mode: "default",
      code: "observing",
      reason: `连续软件合成 ${evidence.softwareLaunches}/${SOFTWARE_LAUNCHES_THRESHOLD} 次，继续观察`,
      switches: [],
    };
  }
  return {
    mode: "nogpu",
    code: "consecutive_software",
    reason: `连续 ${evidence.softwareLaunches} 次观察到软件合成（${evidence.lastGpuCompositing}），本轮不初始化 GPU 进程`,
    switches: ["disable-gpu"],
  };
}

/**
 * 决策变化时的一句话（`gpu mode re-evaluated: default→nogpu, reason=consecutive_software`）。
 *
 * 只在**模式真的变了**时返回非 null；首次启动（无历史决策）也算一次变化，
 * 这样 `grep "re-evaluated" main.log` 能看到完整的决策轨迹。
 */
export function describeReEvaluation(
  previous: { mode: GpuMode; code: GpuDecisionCode } | null,
  next: GpuDecision,
): string | null {
  if (previous && previous.mode === next.mode && previous.code === next.code) return null;
  const from = previous?.mode ?? "none";
  return `gpu mode re-evaluated: ${from}→${next.mode}, reason=${next.code}`;
}

/**
 * 用本轮观测更新证据。
 *
 * - 软件合成 → 计数 +1（上限阈值，避免无限增长）；
 * - 硬件合成 → 清零（机器/会话变好了，下一轮恢复默认）。
 */
export function recordGpuObservation(
  previous: GpuEvidence | null,
  observed: {
    compositing?: unknown;
    featureStatus?: Record<string, string> | null;
    decision?: { mode: GpuMode; code: GpuDecisionCode } | null;
  },
  now: number = Date.now(),
): GpuEvidence {
  const base = previous ?? emptyEvidence();
  const software = isSoftwareCompositing(observed.compositing);
  return {
    version: 2,
    softwareLaunches: software ? Math.min(SOFTWARE_LAUNCHES_THRESHOLD, base.softwareLaunches + 1) : 0,
    lastGpuCompositing: typeof observed.compositing === "string" ? observed.compositing : null,
    probedAt: now,
    gpuFeatureStatus: observed.featureStatus ?? null,
    decision: observed.decision ?? base.decision,
  };
}

/**
 * 解析磁盘上的证据文件。
 *
 * 兼容 v1（只有 `recordedAt`）：迁移时把 `recordedAt` 当 `probedAt`，
 * 这样已有用户的"连续 2 次"计数不会因为升级而丢失。
 */
export function parseGpuEvidence(raw: string | null | undefined): GpuEvidence | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const version = parsed?.version;
    if (version !== 1 && version !== 2) return null;
    const launches = parsed.softwareLaunches;
    if (typeof launches !== "number" || !Number.isFinite(launches)) return null;

    const probedAt =
      typeof parsed.probedAt === "number" && Number.isFinite(parsed.probedAt)
        ? parsed.probedAt
        : typeof parsed.recordedAt === "number" && Number.isFinite(parsed.recordedAt)
          ? parsed.recordedAt
          : 0;

    return {
      version: 2,
      softwareLaunches: Math.max(0, Math.min(SOFTWARE_LAUNCHES_THRESHOLD, Math.floor(launches))),
      lastGpuCompositing: typeof parsed.lastGpuCompositing === "string" ? parsed.lastGpuCompositing : null,
      probedAt,
      gpuFeatureStatus:
        parsed.gpuFeatureStatus && typeof parsed.gpuFeatureStatus === "object"
          ? (parsed.gpuFeatureStatus as Record<string, string>)
          : null,
      decision: readDecision(parsed.decision),
    };
  } catch {
    return null;
  }
}

function readDecision(value: unknown): { mode: GpuMode; code: GpuDecisionCode } | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { mode?: unknown; code?: unknown };
  const modes: GpuMode[] = ["default", "nogpu", "inprocess"];
  const codes: GpuDecisionCode[] = [
    "no_evidence",
    "observing",
    "consecutive_software",
    "hardware_ok",
    "expired",
    "force_override",
  ];
  if (!modes.includes(candidate.mode as GpuMode)) return null;
  if (!codes.includes(candidate.code as GpuDecisionCode)) return null;
  return { mode: candidate.mode as GpuMode, code: candidate.code as GpuDecisionCode };
}
