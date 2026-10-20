/**
 * Crash reaper (v0.5.0 stage 8, step 3).
 *
 * On Host startup, inspect process-state files left by previous Host instances.
 * A file whose owner Host is still alive and heartbeating is left alone. A
 * stale file is quarantined and only **agent-owned** records are terminated,
 * after identity verification; anything unverifiable is reported and left
 * running (fail-closed).
 *
 * This is bounded cleanup, not a sandbox. A process that fully detaches from
 * the recorded tree (double-fork, setsid, service manager) can still escape.
 */
import { existsSync } from "node:fs";
import type { ManagedProcessRecord } from "../contract/domains/processes.ts";
import {
  archiveProcessInstanceState,
  getProcessInstanceId,
  getProcessStateDir,
  readProcessInstanceStates,
  type ProcessInstanceState,
} from "./process-instance-store.ts";
import {
  isPidAlive,
  nodeIdentityVerifier,
  getProcessTerminator,
  type ProcessIdentityVerifier,
  type ProcessTerminator,
} from "./process-killer.ts";

export const HEARTBEAT_STALE_MS = 30_000;

export interface ReapSkipped {
  processId: string;
  name: string;
  pid: number | null;
  reason: string;
}

export interface ReapReport {
  scannedInstances: number;
  liveInstances: number;
  reaped: Array<{ processId: string; name: string; pid: number; strategy: string }>;
  skipped: ReapSkipped[];
  failed: ReapSkipped[];
  archived: string[];
}

export interface ReapOptions {
  stateDir?: string;
  /** Compare against this Host instance; defaults to the live one. */
  ownInstanceId?: string | null;
  now?: number;
  staleAfterMs?: number;
  isPidAlive?: (pid: number) => boolean;
  verifier?: ProcessIdentityVerifier;
  terminator?: ProcessTerminator;
  log?: (message: string) => void;
}

function emptyReport(): ReapReport {
  return { scannedInstances: 0, liveInstances: 0, reaped: [], skipped: [], failed: [], archived: [] };
}

/**
 * Reap dead Host instances. Idempotent: quarantined files are moved to
 * `process-state/orphaned/` so a later startup never retries them blindly.
 */
export async function reapOrphanedProcesses(options: ReapOptions = {}): Promise<ReapReport> {
  const stateDir = options.stateDir ?? getProcessStateDir();
  if (!existsSync(stateDir)) return emptyReport();
  const log = options.log ?? (() => undefined);
  const now = options.now ?? Date.now();
  const staleAfter = options.staleAfterMs ?? HEARTBEAT_STALE_MS;
  const alive = options.isPidAlive ?? isPidAlive;
  const verifier = options.verifier ?? nodeIdentityVerifier;
  const terminator = options.terminator ?? getProcessTerminator();
  const ownId = options.ownInstanceId ?? getProcessInstanceId();
  const report = emptyReport();

  for (const stored of readProcessInstanceStates(stateDir)) {
    const state = stored.state;
    if (ownId && state.instanceId === ownId) continue;
    report.scannedInstances += 1;

    const ownerAlive = alive(state.hostPid);
    const heartbeatFresh = Number.isFinite(state.heartbeatAt) && now - state.heartbeatAt <= staleAfter;
    if (ownerAlive) {
      // Fail-closed: an alive owner pid is never touched, even with a stale
      // heartbeat (it may be a hung host or a reused pid). The heartbeat is
      // reported so operators can spot a wedged Host.
      report.liveInstances += 1;
      if (!heartbeatFresh) {
        log(
          `instance ${state.instanceId} (pid ${state.hostPid}) is alive but its heartbeat is stale; leaving it alone`,
        );
      }
      continue;
    }

    for (const record of state.processes) {
      const skipped = await reapRecord(record, verifier, terminator, report, log);
      if (skipped && !report.skipped.some((entry) => entry.processId === record.id)) {
        report.skipped.push(skipped);
      }
    }

    try {
      archiveProcessInstanceState(stored.path, state as ProcessInstanceState, report, stateDir);
      report.archived.push(stored.path);
    } catch (error) {
      log(`could not archive ${stored.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return report;
}

async function reapRecord(
  record: ManagedProcessRecord,
  verifier: ProcessIdentityVerifier,
  terminator: ProcessTerminator,
  report: ReapReport,
  log: (message: string) => void,
): Promise<ReapSkipped | null> {
  const base = { processId: record.id, name: record.name, pid: record.pid };
  if (record.owner !== "agent") {
    // User-started processes are out of scope for automatic cleanup.
    return { ...base, reason: "owner-not-agent" };
  }
  if (!record.pid) {
    return { ...base, reason: "missing-pid" };
  }

  const identity = await verifier.verify(record);
  if (!identity.ok) {
    const reason = `identity-unverified: ${identity.reason ?? "unknown"}`;
    log(`skipping ${record.name} (${record.id}): ${reason}`);
    report.failed.push({ ...base, reason });
    return null;
  }

  const result = await terminator.terminate({
    pid: record.pid,
    pgid: record.pgid,
    force: true,
    timeoutMs: 3_000,
    retries: 2,
  });
  if (result.ok) {
    report.reaped.push({
      processId: record.id,
      name: record.name,
      pid: record.pid,
      strategy: result.strategy,
    });
    log(`reaped ${record.name} (pid ${record.pid}) via ${result.strategy}`);
  } else {
    report.failed.push({
      ...base,
      reason: `terminate-failed: ${result.error ?? "unknown"}`,
    });
    log(`failed to reap ${record.name} (pid ${record.pid}): ${result.error ?? "unknown"}`);
  }
  return null;
}
