import { watch, type FSWatcher, type Stats } from "node:fs";
import { stat, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Hot-reload for external pi config (~/.pi/agent/**).
 *
 * The desktop app is a UI over the `pi` CLI's on-disk state. When the user (or
 * the CLI itself) edits `models.json`, `auth.json`, `extensions/`, `skills/`,
 * MCP config, …, running sessions must pick it up without an app restart.
 *
 * Two layers:
 *   - `fs.watch(agentDir, { recursive: true })` for instant notifications
 *     (Windows/macOS support recursive; Linux may throw → polling fallback).
 *   - a slow mtime poll as a safety net for editors that replace files with
 *     rename dances or for platforms without recursive watch.
 *
 * On every detected change we bump a version, mark live sessions for a lazy
 * resource reload, and notify SSE subscribers (`/api/config/events`).
 */

export interface ConfigChange {
  version: number;
  changedAt: number;
}

type Listener = (change: ConfigChange) => void;

declare global {
  var __piforgeConfigWatcher: {
    version: number;
    listeners: Set<Listener>;
    watcher: FSWatcher | null;
    pollTimer: ReturnType<typeof setInterval> | null;
    debounceTimer: ReturnType<typeof setTimeout> | null;
    lastSnapshot: string;
    started: boolean;
  } | undefined;
}

/**
 * 运行态目录/文件：会话 jsonl、受管进程状态、LTM sqlite、日志与缓存。
 * 它们每写一条都会触发 fs.watch，但和「配置热重载」无关 —— 不过滤的话
 * 每 250ms 就 emit 一次，Next 侧会不停重拉 /api/sessions，左侧会话栏一直跳。
 */
const VOLATILE_PATHS = ["sessions", "process-state", "memory", "logs", "cache"];

/**
 * 是否是高频运行态写入（不是配置变更）。
 *
 * `fs.watch(recursive)` 回调给的是**相对 agentDir 的完整路径**，例如
 * `sessions/--D--Pi-PiForge--/2026-….jsonl`。只比顶层名字会把每次会话落盘
 * 都当成「配置变了」，触发整棵树刷新：侧栏每 10s 重拉一次 /api/sessions，
 * 界面跟着抖。所以按**首段**匹配，并兼容 `process-state.json` 这类带后缀的运行态文件。
 */
function isVolatilePath(name: string): boolean {
  if (!name) return false;
  const normalized = name.replace(/\\/g, "/").replace(/^\/+/, "");
  const head = normalized.split("/")[0] ?? "";
  return VOLATILE_PATHS.some(
    (hint) => head === hint || head.startsWith(`${hint}.`) || normalized === hint,
  );
}

const POLL_INTERVAL_MS = 5000;
const DEBOUNCE_MS = 250;

function state() {
  if (!globalThis.__piforgeConfigWatcher) {
    globalThis.__piforgeConfigWatcher = {
      version: 0,
      listeners: new Set(),
      watcher: null,
      pollTimer: null,
      debounceTimer: null,
      lastSnapshot: "",
      started: false,
    };
  }
  return globalThis.__piforgeConfigWatcher;
}

async function snapshot(agentDir: string): Promise<string> {
  // Cheap fingerprint: mtime+size of the top-level config files plus the
  // directory mtimes of extensions/skills. Avoids recursively hashing
  // potentially large directories on every poll tick.
  const parts: string[] = [];
  const entries = await readdir(agentDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    if (isVolatilePath(entry.name)) continue;
    const full = join(agentDir, entry.name);
    const info: Stats | null = await stat(full).catch(() => null);
    if (!info) continue;
    parts.push(`${entry.name}:${info.mtimeMs}:${info.size}`);
    if (entry.isDirectory() && (entry.name === "extensions" || entry.name === "skills")) {
      const children = await readdir(full).catch(() => []);
      parts.push(`${entry.name}/[${children.sort().join(",")}]`);
    }
  }
  return parts.join("|");
}

function emit(agentDir: string, reason: string): void {
  const s = state();
  s.version += 1;
  const change: ConfigChange = { version: s.version, changedAt: Date.now() };
  console.error(`[config-watcher] ${reason} → reload v${change.version}`);
  for (const listener of s.listeners) {
    try {
      listener(change);
    } catch (error) {
      console.error("config-watcher listener failed:", error);
    }
  }
  // Lazy session reload in the Agent Host: the next prompt uses fresh
  // extensions/skills/MCP.
  void import("./agent-host-client.ts")
    .then(({ getAgentHostClient }) => getAgentHostClient().call("agent.reloadResources", {}))
    .catch(() => {
      /* host not running yet — nothing to reload */
    });
  // Refresh the fingerprint so the poll does not fire again for this change.
  void snapshot(agentDir).then((next) => {
    state().lastSnapshot = next;
  });
}

function schedule(agentDir: string, reason: string): void {
  const s = state();
  if (s.debounceTimer) clearTimeout(s.debounceTimer);
  s.debounceTimer = setTimeout(() => {
    s.debounceTimer = null;
    emit(agentDir, reason);
  }, DEBOUNCE_MS);
}

/** Start the watcher once per server process (idempotent, HMR-safe). */
export function startAgentConfigWatcher(agentDir: string): void {
  const s = state();
  if (s.started) return;
  s.started = true;

  try {
    s.watcher = watch(agentDir, { recursive: true, persistent: false }, (_event, filename) => {
      const name = filename ? String(filename) : "";
      // Ignore lock/temp noise from atomic writes.
      if (name.endsWith(".lock") || name.endsWith(".tmp")) return;
      // 运行态写入（会话记录、进程状态、LTM）不是配置变更，直接忽略。
      if (isVolatilePath(name)) return;
      schedule(agentDir, `watch ${name || "*"}`);
    });
    s.watcher.on("error", (error) => {
      console.error("config-watcher fs.watch error:", error);
    });
  } catch (error) {
    // Linux without recursive watch support: polling still keeps us fresh.
    console.error("config-watcher recursive watch unavailable:", error);
  }

  void snapshot(agentDir).then((value) => {
    state().lastSnapshot = value;
  });

  s.pollTimer = setInterval(() => {
    void snapshot(agentDir).then((next) => {
      if (next !== state().lastSnapshot) {
        state().lastSnapshot = next;
        schedule(agentDir, "poll");
      }
    });
  }, POLL_INTERVAL_MS);
}

export function getConfigVersion(): number {
  return state().version;
}

export function onConfigChange(listener: Listener): () => void {
  const s = state();
  s.listeners.add(listener);
  return () => s.listeners.delete(listener);
}
