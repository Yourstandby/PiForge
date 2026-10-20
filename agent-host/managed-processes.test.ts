import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  forceStopManagedProcess,
  listManagedProcesses,
  readManagedProcessLogs,
  resetManagedProcessesForTest,
  restartManagedProcess,
  sanitizeLogLine,
  startManagedProcess,
  stopManagedProcess,
} from "./managed-processes.ts";
import {
  resetProcessInstanceStateForTest,
  shutdownProcessInstanceState,
} from "./process-instance-store.ts";
import { isPidAlive, nodeProcessTerminator, setProcessTerminator } from "./process-killer.ts";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

function setupEnv() {
  const dir = mkdtempSync(join(tmpdir(), "pi-managed-processes-"));
  const previous = process.env[AGENT_DIR_ENV];
  process.env[AGENT_DIR_ENV] = join(dir, "agent");
  resetProcessInstanceStateForTest();
  return {
    dir,
    cleanup: async () => {
      setProcessTerminator(nodeProcessTerminator);
      await resetManagedProcessesForTest();
      shutdownProcessInstanceState();
      resetProcessInstanceStateForTest();
      if (previous === undefined) delete process.env[AGENT_DIR_ENV];
      else process.env[AGENT_DIR_ENV] = previous;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`timed out waiting for ${message}`);
}

function view(id: string) {
  return listManagedProcesses().find((entry) => entry.id === id);
}

test("start → running → readiness/endpoint → stop is a clean stop", { timeout: 30000 }, async () => {
  const env = setupEnv();
  try {
    const started = startManagedProcess({
      cwd: env.dir,
      command: `node -e "console.log('ready in 100ms'); console.log('Local: http://localhost:12345/app'); setInterval(()=>{}, 60000)"`,
      name: "fixture-server",
      owner: "agent",
    });
    assert.equal(started.owner, "agent");
    assert.ok(["starting", "running"].includes(started.status));

    await waitFor(() => view(started.id)?.status === "running", "status running");
    await waitFor(() => view(started.id)?.readiness === "ready", "readiness ready");
    await waitFor(() => view(started.id)?.endpoint !== null, "endpoint detected");
    const running = view(started.id)!;
    assert.equal(running.owner, "agent");
    assert.equal(running.ready, true);
    assert.equal(running.endpoint?.host, "localhost");
    assert.equal(running.endpoint?.port, 12345);
    assert.equal(running.url, running.endpoint?.url);
    assert.ok(running.logLineCount >= 2);
    assert.equal(running.exitReason, null);

    assert.equal(await stopManagedProcess(started.id, { force: true }), true);
    const stopped = view(started.id)!;
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.exitReason, "stopped");
    assert.equal(stopped.readiness, "ready");
    assert.equal(stopped.cleanup?.ok, true);
    assert.equal(stopped.cleanup?.strategy !== "", true);
    assert.equal(stopped.endpoint?.port, 12345);
  } finally {
    await env.cleanup();
  }
});

test("natural exit versus crash uses the exit code", { timeout: 30000 }, async () => {
  const env = setupEnv();
  try {
    const natural = startManagedProcess({
      cwd: env.dir,
      command: `node -e "process.exit(0)"`,
      owner: "agent",
    });
    await waitFor(() => view(natural.id)?.endedAt !== null, "natural exit");
    assert.equal(view(natural.id)?.status, "exited");
    assert.equal(view(natural.id)?.exitReason, "natural");
    assert.equal(view(natural.id)?.exitCode, 0);
    assert.equal(view(natural.id)?.readiness, "failed");

    const crashed = startManagedProcess({
      cwd: env.dir,
      command: `node -e "process.exit(3)"`,
      owner: "agent",
    });
    await waitFor(() => view(crashed.id)?.endedAt !== null, "crashed exit");
    assert.equal(view(crashed.id)?.status, "crashed");
    assert.equal(view(crashed.id)?.exitReason, "crashed");
    assert.equal(view(crashed.id)?.exitCode, 3);
  } finally {
    await env.cleanup();
  }
});

test("cleanup failure is reported, not swallowed", { timeout: 30000 }, async () => {
  const env = setupEnv();
  try {
    const started = startManagedProcess({
      cwd: env.dir,
      command: `node -e "setInterval(()=>{}, 60000)"`,
      owner: "agent",
    });
    await waitFor(() => view(started.id)?.status === "running", "status running");

    setProcessTerminator({
      name: "failing-fixture",
      terminate: async () => ({
        ok: false,
        strategy: "fixture",
        attempts: 3,
        forced: true,
        error: "simulated lock",
      }),
    });
    await stopManagedProcess(started.id, { force: true });
    const failed = view(started.id)!;
    assert.equal(failed.status, "stopped");
    assert.equal(failed.exitReason, "cleanup-failed");
    assert.equal(failed.cleanup?.ok, false);
    assert.match(failed.cleanup?.error ?? "", /simulated lock/);
    assert.ok(failed.logs.some((line) => line.includes("[cleanup] failed")));

    // Restore the real terminator and actually clean the tree up.
    setProcessTerminator(nodeProcessTerminator);
    await forceStopManagedProcess(started.id);
    await waitFor(() => view(started.id)?.cleanup?.ok === true, "cleanup recovered");
  } finally {
    await env.cleanup();
  }
});

test("process group cleanup kills grandchildren (bounded tree)", { timeout: 30000 }, async () => {
  const env = setupEnv();
  try {
    const started = startManagedProcess({
      cwd: env.dir,
      // The direct child starts another long-lived node process.
      command: `node -e "const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);console.log('grandchild '+c.pid);setInterval(()=>{},1000)"`,
      owner: "agent",
    });
    await waitFor(
      () => (view(started.id)?.logs ?? []).some((line) => /^grandchild \d+/.test(line)),
      "grandchild pid",
    );
    const line = view(started.id)!.logs.find((entry) => /^grandchild \d+/.test(entry))!;
    const grandchildPid = Number(line.split(" ")[1]);
    assert.equal(isPidAlive(grandchildPid), true);

    await stopManagedProcess(started.id, { force: true });
    await waitFor(() => !isPidAlive(grandchildPid), "grandchild gone");
    assert.equal(view(started.id)?.cleanup?.ok, true);
  } finally {
    await env.cleanup();
  }
});

test("restart keeps the id and log history and increments restartCount", { timeout: 30000 }, async () => {
  const env = setupEnv();
  try {
    const started = startManagedProcess({
      cwd: env.dir,
      command: `node -e "setInterval(()=>{}, 60000)"`,
      owner: "agent",
    });
    await waitFor(() => view(started.id)?.status === "running", "first run");

    const restarted = await restartManagedProcess(started.id);
    assert.ok(restarted);
    assert.equal(restarted.id, started.id);
    assert.equal(restarted.restartCount, 1);
    assert.ok(restarted.logs.includes("--- restarted ---"));
    await waitFor(() => view(started.id)?.status === "running", "second run");
    assert.equal(view(started.id)?.restartCount, 1);
    assert.equal(view(started.id)?.exitReason, null);
  } finally {
    await env.cleanup();
  }
});

test("log read uses an absolute cursor", { timeout: 30000 }, async () => {
  const env = setupEnv();
  try {
    const started = startManagedProcess({
      cwd: env.dir,
      command: `node -e "for(let i=0;i<10;i++) console.log('line '+i); setInterval(()=>{}, 60000)"`,
      owner: "agent",
    });
    await waitFor(() => (view(started.id)?.logLineCount ?? 0) >= 10, "10 log lines");

    const first = readManagedProcessLogs(started.id, { cursor: 0, limit: 5 });
    assert.ok(first);
    assert.equal(first.lines.length, 5);
    assert.equal(first.cursor, 0);
    assert.equal(first.nextCursor, 5);
    assert.equal(first.totalLines, 10);

    const second = readManagedProcessLogs(started.id, { cursor: first.nextCursor, limit: 5 });
    assert.ok(second);
    assert.deepEqual(second.lines, ["line 5", "line 6", "line 7", "line 8", "line 9"]);
    assert.equal(second.nextCursor, 10);
  } finally {
    await env.cleanup();
  }
});

test("owner defaults to user for manual starts", () => {
  const env = setupEnv();
  try {
    const started = startManagedProcess({ cwd: env.dir, command: `node -e "process.exit(0)"` });
    assert.equal(started.owner, "user");
  } finally {
    void env.cleanup();
  }
});

test("sanitizeLogLine masks home paths and credentials", () => {
  assert.match(sanitizeLogLine("C:\\Users\\alice\\project\\a.ts"), /^~\\project\\a\.ts$/);
  assert.equal(sanitizeLogLine("/home/alice/project/a.ts"), "~/project/a.ts");
  assert.equal(sanitizeLogLine("/Users/bob/project/a.ts"), "~/project/a.ts");
  assert.equal(sanitizeLogLine("OPENAI_API_KEY=sk-abcdef123456"), "OPENAI_API_KEY=[redacted]");
});
