/**
 * Persisted per-host process registry (crash reaper input).
 *
 * One file per Agent Host instance under `<agent-dir>/process-state/`:
 *   { instanceId, hostPid, startedAt, heartbeatAt, processes: [...] }
 *
 * The live Host rewrites it on every process change and heartbeats it every
 * 10s. A crashed Host leaves the file behind; the next Host reaps it after the
 * heartbeat goes stale. See `crash-reaper.ts`.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ManagedProcessRecord } from "../contract/domains/processes.ts";
import { writeFileAtomic } from "../lib/atomic-write.ts";

const HEARTBEAT_INTERVAL_MS = 10_000;

export interface ProcessInstanceState {
  version: 1;
  instanceId: string;
  hostPid: number;
  startedAt: number;
  heartbeatAt: number;
  processes: ManagedProcessRecord[];
  lastReapAt?: number;
  lastReapReport?: unknown;
}

interface InstanceHandle {
  id: string;
  startedAt: number;
  filePath: string;
  stateDir: string;
}

let handle: InstanceHandle | null = null;
let records = new Map<string, ManagedProcessRecord>();
let heartbeat: ReturnType<typeof setInterval> | null = null;

export function getProcessStateDir(): string {
  return join(getAgentDir(), "process-state");
}

function writeState(): void {
  if (!handle) return;
  const state: ProcessInstanceState = {
    version: 1,
    instanceId: handle.id,
    hostPid: process.pid,
    startedAt: handle.startedAt,
    heartbeatAt: Date.now(),
    processes: [...records.values()],
  };
  try {
    writeFileAtomic(handle.filePath, `${JSON.stringify(state, null, 2)}\n`);
  } catch (error) {
    // Never let bookkeeping break process control; the next heartbeat retries.
    console.error("process-state: write failed", error);
  }
}

/** Create this host's instance file (idempotent). */
export function ensureProcessInstanceState(options: { stateDir?: string } = {}): string {
  if (handle) return handle.id;
  const stateDir = options.stateDir ?? getProcessStateDir();
  mkdirSync(stateDir, { recursive: true });
  const id = randomUUID();
  handle = {
    id,
    startedAt: Date.now(),
    filePath: join(stateDir, `${id}.json`),
    stateDir,
  };
  records = new Map();
  writeState();
  heartbeat = setInterval(writeState, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();
  return id;
}

/** Null before the Host starts its first managed process. */
export function getProcessInstanceId(): string | null {
  return handle?.id ?? null;
}

export function getProcessInstanceFilePath(): string | null {
  return handle?.filePath ?? null;
}

export function upsertProcessRecord(
  record: Omit<ManagedProcessRecord, "hostInstanceId">,
): void {
  if (!handle) ensureProcessInstanceState();
  records.set(record.id, { ...record, hostInstanceId: handle!.id });
  writeState();
}

export function removeProcessRecord(id: string): void {
  if (!handle) return;
  if (records.delete(id)) writeState();
}

/**
 * Clean shutdown: drop the file so the next Host has nothing to reap.
 * If cleanup failed, keep the file (with the remaining records) so the next
 * Host's crash reaper can retry instead of leaking orphans.
 */
export function shutdownProcessInstanceState(options: { keepForReaper?: boolean } = {}): void {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
  if (handle) {
    if (options.keepForReaper && records.size > 0) {
      writeState();
    } else {
      try {
        unlinkSync(handle.filePath);
      } catch {
        // Already removed.
      }
    }
  }
  handle = null;
  records = new Map();
}

/** Test helper: clear in-memory state without touching files. */
export function resetProcessInstanceStateForTest(): void {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
  handle = null;
  records = new Map();
}

export interface StoredInstance {
  path: string;
  state: ProcessInstanceState;
}

/** Read every instance file, ignoring malformed ones (defensive). */
export function readProcessInstanceStates(
  stateDir: string = getProcessStateDir(),
): StoredInstance[] {
  if (!existsSync(stateDir)) return [];
  const out: StoredInstance[] = [];
  for (const entry of readdirSync(stateDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(stateDir, entry.name);
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const state = parsed as ProcessInstanceState;
      if (typeof state.instanceId !== "string" || !Array.isArray(state.processes)) continue;
      out.push({ path, state });
    } catch {
      // Unreadable/invalid: ignore it; it is not safe to act on.
    }
  }
  return out;
}

/** Preserve dead-instance files for inspection instead of deleting evidence. */
export function archiveProcessInstanceState(
  path: string,
  state: ProcessInstanceState,
  report: unknown,
  stateDir: string = getProcessStateDir(),
): void {
  try {
    const orphanedDir = join(stateDir, "orphaned");
    mkdirSync(orphanedDir, { recursive: true });
    const target = join(orphanedDir, basename(path));
    writeFileAtomic(
      target,
      `${JSON.stringify({ ...state, archivedAt: Date.now(), report }, null, 2)}\n`,
    );
    unlinkSync(path);
  } catch (error) {
    console.error("process-state: archive failed", error);
  }
}
