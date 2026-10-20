import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManagedProcessRecord } from "../contract/domains/processes.ts";
import { reapOrphanedProcesses, HEARTBEAT_STALE_MS } from "./crash-reaper.ts";
import type { ProcessIdentityVerifier, ProcessTerminator, TerminateOptions } from "./process-killer.ts";

function record(overrides: Partial<ManagedProcessRecord> = {}): ManagedProcessRecord {
  return {
    id: overrides.id ?? "proc-1",
    owner: overrides.owner ?? "agent",
    name: overrides.name ?? "fixture",
    command: overrides.command ?? "node server.js",
    cwd: overrides.cwd ?? "/tmp/project",
    pid: overrides.pid ?? 4242,
    pgid: overrides.pgid ?? 4242,
    startedAt: overrides.startedAt ?? Date.now() - 60_000,
    hostInstanceId: overrides.hostInstanceId ?? "old-instance",
  };
}

function instanceFile(
  stateDir: string,
  id: string,
  overrides: {
    hostPid?: number;
    heartbeatAt?: number;
    processes?: ManagedProcessRecord[];
  } = {},
): string {
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, `${id}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      instanceId: id,
      hostPid: overrides.hostPid ?? 4_000_000,
      startedAt: Date.now() - 120_000,
      heartbeatAt: overrides.heartbeatAt ?? Date.now() - HEARTBEAT_STALE_MS - 1_000,
      processes: overrides.processes ?? [],
    }),
  );
  return path;
}

function fakeVerifier(okIds: string[]): ProcessIdentityVerifier {
  return {
    name: "fake",
    async verify(record) {
      return okIds.includes(record.id)
        ? { ok: true }
        : { ok: false, reason: "fixture mismatch" };
    },
  };
}

function fakeTerminator(calls: TerminateOptions[]): ProcessTerminator {
  return {
    name: "fake",
    async terminate(options) {
      calls.push(options);
      return { ok: true, strategy: "fake", attempts: 1, forced: true };
    },
  };
}

test("a live owner instance is never touched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-reaper-live-"));
  const stateDir = join(dir, "state");
  try {
    const path = instanceFile(stateDir, "live-instance", {
      hostPid: process.pid,
      heartbeatAt: Date.now(),
      processes: [record()],
    });
    const calls: TerminateOptions[] = [];
    const report = await reapOrphanedProcesses({
      stateDir,
      ownInstanceId: "current",
      verifier: fakeVerifier(["proc-1"]),
      terminator: fakeTerminator(calls),
    });
    assert.equal(report.liveInstances, 1);
    assert.equal(report.reaped.length, 0);
    assert.equal(calls.length, 0);
    assert.equal(existsSync(path), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dead instances reap only verified agent-owned records", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-reaper-dead-"));
  const stateDir = join(dir, "state");
  try {
    const path = instanceFile(stateDir, "dead-instance", {
      processes: [
        record({ id: "agent-ok", name: "ok", pid: 1111, pgid: 1111 }),
        record({ id: "user-owned", name: "user", pid: 2222, pgid: 2222, owner: "user" }),
        record({ id: "agent-unverified", name: "unverified", pid: 3333, pgid: 3333 }),
      ],
    });
    const calls: TerminateOptions[] = [];
    const report = await reapOrphanedProcesses({
      stateDir,
      ownInstanceId: "current",
      isPidAlive: (pid) => pid === process.pid,
      verifier: fakeVerifier(["agent-ok"]),
      terminator: fakeTerminator(calls),
    });

    assert.deepEqual(calls.map((call) => call.pid), [1111]);
    assert.equal(report.reaped.length, 1);
    assert.equal(report.reaped[0].processId, "agent-ok");
    assert.ok(report.skipped.some((entry) => entry.processId === "user-owned" && entry.reason === "owner-not-agent"));
    assert.ok(
      report.failed.some(
        (entry) => entry.processId === "agent-unverified" && entry.reason.startsWith("identity-unverified"),
      ),
    );

    // The dead instance is archived (with the report) and removed from scans.
    assert.equal(existsSync(path), false);
    assert.equal(report.archived.length, 1);
    const archived = readdirSync(join(stateDir, "orphaned"));
    assert.equal(archived.length, 1);
    const archivedState = JSON.parse(readFileSync(join(stateDir, "orphaned", archived[0]), "utf-8"));
    assert.equal(archivedState.instanceId, "dead-instance");
    assert.equal(archivedState.report.reaped.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stale heartbeat from a still-alive pid is treated as live", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-reaper-stale-"));
  const stateDir = join(dir, "state");
  try {
    instanceFile(stateDir, "slow-instance", {
      hostPid: 12345,
      heartbeatAt: Date.now() - HEARTBEAT_STALE_MS - 60_000,
      processes: [record({ pid: 9999 })],
    });
    const calls: TerminateOptions[] = [];
    const report = await reapOrphanedProcesses({
      stateDir,
      ownInstanceId: "current",
      isPidAlive: (pid) => pid === 12345,
      verifier: fakeVerifier(["proc-1"]),
      terminator: fakeTerminator(calls),
    });
    assert.equal(report.liveInstances, 1);
    assert.equal(calls.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the reaper never reaps its own instance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-reaper-own-"));
  const stateDir = join(dir, "state");
  try {
    instanceFile(stateDir, "current", {
      hostPid: 4_000_000,
      heartbeatAt: 0,
      processes: [record()],
    });
    const calls: TerminateOptions[] = [];
    const report = await reapOrphanedProcesses({
      stateDir,
      ownInstanceId: "current",
      verifier: fakeVerifier(["proc-1"]),
      terminator: fakeTerminator(calls),
    });
    assert.equal(report.scannedInstances, 0);
    assert.equal(calls.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("terminate failures are reported instead of silently dropped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-reaper-fail-"));
  const stateDir = join(dir, "state");
  try {
    instanceFile(stateDir, "dead-instance", {
      processes: [record({ id: "agent-ok", pid: 1111 })],
    });
    const report = await reapOrphanedProcesses({
      stateDir,
      ownInstanceId: "current",
      isPidAlive: (pid) => pid === process.pid,
      verifier: fakeVerifier(["agent-ok"]),
      terminator: {
        name: "failing",
        async terminate() {
          return { ok: false, strategy: "fake", attempts: 2, forced: true, error: "still alive" };
        },
      },
    });
    assert.equal(report.reaped.length, 0);
    assert.equal(report.failed.length, 1);
    assert.match(report.failed[0].reason, /terminate-failed: still alive/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
