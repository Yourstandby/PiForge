/**
 * Prompt 缓存保活与首轮预热（第 4 步）。
 *
 * 两件事分开：
 *   1. **保活**：pi 自带 `CacheWarmer`（按模型声明的 promptCache TTL 在 90% 处重放
 *      上一次请求，`maxTokens: 1`）。桌面端的问题是模式从来没被显式设置过，
 *      设置页读的是原始 settings 值（常常是 undefined → 显示成 "off"）。
 *      这里把「读原始设置 → 解析 → 落到会话」这条链补上，并给桌面端一个
 *      `idle` 默认值（用户读回答/打字时缓存不会过期）。
 *   2. **首轮预热**：会话恢复时系统提示词与工具集已经在 `agent.state` 里，
 *      可以在用户发第一条消息前先重放一次前缀（`maxTokens: 1`）。新会话不一样：
 *      system prompt 要等第一次 `before_agent_start` 才生成，没有可预热的前缀，
 *      所以这里明确跳过并说明原因，而不是发一个字节不同的请求白付一次写入。
 *
 * 纯函数 + 窄接口：不 import SDK 类型，方便单测。
 */
import type { AgentSessionLike } from "../lib/pi-types.ts";

export type CacheWarmingMode = "off" | "streaming" | "idle";

export const CACHE_WARMING_MODES: readonly CacheWarmingMode[] = ["off", "streaming", "idle"];

/**
 * 桌面端默认：`idle`。
 *
 * pi 的默认是 `streaming`（只在流式间隙保活，settle 就停），适合终端里"一问一答
 * 紧接着下一问"。桌面端用户经常读完回答去改代码、几分钟后再回来 —— 那段时间
 * 缓存已经过期，所以默认改成 idle（settle 后仍按 TTL 续命，最长 30 分钟）。
 */
export const DESKTOP_DEFAULT_CACHE_WARMING: CacheWarmingMode = "idle";

export function isCacheWarmingMode(value: unknown): value is CacheWarmingMode {
  return typeof value === "string" && (CACHE_WARMING_MODES as readonly string[]).includes(value);
}

/** 原始设置 → 有效模式。未设置时用桌面默认值。 */
export function resolveCacheWarmingMode(rawSetting: unknown): CacheWarmingMode {
  return isCacheWarmingMode(rawSetting) ? rawSetting : DESKTOP_DEFAULT_CACHE_WARMING;
}

interface CacheWarmingCapable {
  setCacheWarmingMode?(mode: CacheWarmingMode): void;
  settingsManager?: { getCacheWarmingMode?(): string | undefined; getSettings?(): unknown };
  cacheWarmingStatus?: unknown;
}

/**
 * 把设置落到会话上（幂等）。返回有效模式，调用方可以据此上报状态。
 * `off` 也显式写一次：这样设置页显示的就是 pi 真正在用的值，而不是"没设置过"。
 */
export function applyCacheWarmingPolicy(inner: CacheWarmingCapable, rawSetting: unknown): CacheWarmingMode {
  const mode = resolveCacheWarmingMode(rawSetting);
  try {
    const current = inner.settingsManager?.getCacheWarmingMode?.();
    if (current !== mode) inner.setCacheWarmingMode?.(mode);
  } catch {
    // 写设置失败不该拦住会话启动：pi 会退回它自己的默认值。
  }
  return mode;
}

/** 设置页/状态栏用的真实视图（不是"原始设置值"）。 */
export interface CacheWarmingView {
  mode: CacheWarmingMode;
  /** pi 的 warmer 状态：inactive / scheduled / refreshing。 */
  state: "inactive" | "scheduled" | "refreshing" | "unknown";
  reason?: string;
  nextWarmAt?: number;
}

export function describeCacheWarming(inner: CacheWarmingCapable, rawSetting?: unknown): CacheWarmingView {
  const mode = isCacheWarmingMode(rawSetting)
    ? rawSetting
    : (inner.settingsManager?.getCacheWarmingMode?.() as CacheWarmingMode | undefined) ??
      resolveCacheWarmingMode(undefined);
  const status = inner.cacheWarmingStatus as
    | { state?: string; reason?: string; nextWarmAt?: number }
    | undefined;
  const state = status?.state;
  return {
    mode: isCacheWarmingMode(mode) ? mode : DESKTOP_DEFAULT_CACHE_WARMING,
    state:
      state === "inactive" || state === "scheduled" || state === "refreshing" ? state : "unknown",
    ...(typeof status?.reason === "string" ? { reason: status.reason } : {}),
    ...(typeof status?.nextWarmAt === "number" ? { nextWarmAt: status.nextWarmAt } : {}),
  };
}

export interface PrewarmResult {
  sent: boolean;
  reason: string;
}

interface PrewarmCapable {
  isStreaming?: boolean;
  model?: unknown;
  agent?: {
    state?: {
      systemPrompt?: string;
      messages?: unknown[];
      tools?: unknown[];
    };
  };
  modelRuntime?: {
    streamSimple?: (
      model: unknown,
      context: { systemPrompt: string; messages: unknown[]; tools: unknown[] },
      options: { maxTokens: number; maxRetries: number }
    ) => { result?: () => Promise<unknown> } | Promise<unknown>;
  };
}

/**
 * 用 `maxTokens: 1` 重放一次当前前缀，把 prompt cache 提前建好。
 *
 * 只在**已经有 system prompt** 时发（恢复的会话有；全新会话没有 → 跳过）。
 * 请求体取自 `agent.state` 的 systemPrompt / messages / tools，与 pi 真正发出的
 * 那条请求同源，所以前缀字节一致、缓存能命中。
 */
export async function warmPromptPrefix(inner: PrewarmCapable): Promise<PrewarmResult> {
  if (inner.isStreaming) return { sent: false, reason: "session is streaming" };
  const state = inner.agent?.state;
  const systemPrompt = state?.systemPrompt?.trim();
  if (!systemPrompt) {
    return { sent: false, reason: "no system prompt yet (new session: the first turn writes the cache)" };
  }
  if (!inner.model) return { sent: false, reason: "no model selected" };
  const runtime = inner.modelRuntime;
  if (typeof runtime?.streamSimple !== "function") {
    return { sent: false, reason: "model runtime cannot stream" };
  }
  try {
    const stream = await Promise.resolve(
      // 必须带 receiver：ModelRuntime.streamSimple 内部用 this.prepareRequest。
      runtime.streamSimple(
        inner.model,
        {
          systemPrompt,
          // 恢复的 transcript 里已经有 system 消息；systemPrompt 是单独传的，
          // 两者一起给会被 normalizeContext 拼成两份（前缀直接多出 ~3.8k token，
          // 预热写进缓存的是另一条前缀，等于白付一次写入）。
          messages: (state?.messages ?? []).filter(
            (message) => (message as { role?: string })?.role !== "system"
          ),
          tools: state?.tools ?? [],
        },
        { maxTokens: 1, maxRetries: 0 }
      )
    );
    const result = (stream as { result?: () => Promise<unknown> })?.result;
    // 预热请求不回 transcript，但要检查它到底成没成：provider 的失败是
    // "resolve 成一条 stopReason=error 的消息"，不是抛异常。
    const message = typeof result === "function" ? ((await result.call(stream)) as {
      stopReason?: string;
      errorMessage?: string;
    }) : undefined;
    if (message?.stopReason === "error" || message?.stopReason === "aborted") {
      return { sent: false, reason: message.errorMessage ?? `prewarm ${message.stopReason}` };
    }
    return { sent: true, reason: "prewarmed" };
  } catch (error) {
    return { sent: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** 会话是否有可预热的历史（新会话没有 system prompt，预热无意义）。 */
export function hasReplayablePrefix(inner: AgentSessionLike): boolean {
  const entries = inner.sessionManager?.getEntries?.() ?? [];
  return entries.length > 0;
}
