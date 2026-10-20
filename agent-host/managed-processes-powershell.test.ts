import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  forceStopManagedProcess,
  listManagedProcesses,
  resetManagedProcessesForTest,
  startManagedProcess,
} from "./managed-processes.ts";
import {
  resetProcessInstanceStateForTest,
  shutdownProcessInstanceState,
} from "./process-instance-store.ts";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

function setupEnv() {
  const dir = mkdtempSync(join(tmpdir(), "pi-managed-powershell-"));
  const previous = process.env[AGENT_DIR_ENV];
  process.env[AGENT_DIR_ENV] = join(dir, "agent");
  resetProcessInstanceStateForTest();
  return {
    dir,
    cleanup: async () => {
      await resetManagedProcessesForTest();
      shutdownProcessInstanceState();
      resetProcessInstanceStateForTest();
      if (previous === undefined) delete process.env[AGENT_DIR_ENV];
      else process.env[AGENT_DIR_ENV] = previous;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("run_bg PowerShell uses the managed lifecycle and UTF-8 logs", { skip: process.platform !== "win32", timeout: 30000 }, async () => {
  const env = setupEnv();
  try {
    const started = startManagedProcess({
      cwd: env.dir,
      command: "Write-Output 'ready in 10ms'; Write-Output 'Local: http://localhost:45679/'; Write-Output '中文日志'; Start-Sleep -Seconds 30",
      name: "ps-fixture",
      owner: "agent",
      shell: "powershell",
    });
    assert.equal(started.shell, "powershell");

    const deadline = Date.now() + 15_000;
    let current = listManagedProcesses().find((entry) => entry.id === started.id);
    while (Date.now() < deadline) {
      current = listManagedProcesses().find((entry) => entry.id === started.id);
      if (current?.readiness === "ready" && current.logs.some((line) => line.includes("中文日志"))) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(current?.readiness, "ready", current?.logs.join("\n"));
    assert.equal(current?.endpoint?.port, 45679);
    assert.ok(current?.logs.some((line) => line.includes("中文日志")), current?.logs.join("\n"));

    await forceStopManagedProcess(started.id);
  } finally {
    await env.cleanup();
  }
});

test("PowerShell shell is rejected outside Windows", { skip: process.platform === "win32" }, () => {
  assert.throws(
    () =>
      startManagedProcess({
        cwd: tmpdir(),
        command: "Write-Output hi",
        shell: "powershell",
      }),
    /only available on Windows/,
  );
});
