/**
 * 用量相关类型（原 `StatsBar` 时代就在这两个模块之间来回 import，
 * 状态栏 chip 下线后单独放在这里，避免再从某个已废弃的组件里取类型）。
 */
import type { SessionActivity, SessionStats } from "@/hooks/agent-session/session-stats";
import type { ContextUsage } from "@/lib/pi-types";

export type { SessionActivity, SessionStats, ContextUsage };
