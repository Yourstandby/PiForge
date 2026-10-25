import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AccessDeniedError,
  addAllowedRoot,
  authorizePath,
  isProjectIsolationEnabled,
  resetIsolationCache,
  setActiveScope,
} from "./allowed-roots.ts";
import { writeDesktopSettings, defaultDesktopSettings } from "../lib/desktop-settings.ts";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

function withAgentDir<T>(dir: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env[AGENT_DIR_ENV];
  process.env[AGENT_DIR_ENV] = dir;
  resetIsolationCache();
  return run().finally(() => {
    resetIsolationCache();
    if (previous === undefined) delete process.env[AGENT_DIR_ENV];
    else process.env[AGENT_DIR_ENV] = previous;
  });
}

function sandbox(): { agentDir: string; projectA: string; projectB: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pi-isolation-"));
  const agentDir = join(root, "agent");
  const projectA = join(root, "project-a");
  const projectB = join(root, "project-b");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(projectA, { recursive: true });
  mkdirSync(projectB, { recursive: true });
  writeFileSync(join(projectA, "a.txt"), "a");
  writeFileSync(join(projectB, "b.txt"), "b");
  return { agentDir, projectA, projectB, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("项目隔离默认关闭：别的项目的文件照旧可读", async () => {
  const box = sandbox();
  try {
    addAllowedRoot(box.projectA);
    addAllowedRoot(box.projectB);
    await withAgentDir(box.agentDir, async () => {
      assert.equal(isProjectIsolationEnabled(), false);
      const real = await authorizePath(join(box.projectB, "b.txt"), "read", box.projectA);
      assert.ok(real.endsWith("b.txt"));
    });
  } finally {
    box.cleanup();
  }
});

test("开启项目隔离后：范围内可读，跨项目被拒（AccessDenied）", async () => {
  const box = sandbox();
  try {
    addAllowedRoot(box.projectA);
    addAllowedRoot(box.projectB);
    writeDesktopSettings(box.agentDir, { ...defaultDesktopSettings(), projectIsolation: true });
    await withAgentDir(box.agentDir, async () => {
      assert.equal(isProjectIsolationEnabled(), true);
      const inside = await authorizePath(join(box.projectA, "a.txt"), "read", box.projectA);
      assert.ok(inside.endsWith("a.txt"));
      await assert.rejects(
        () => authorizePath(join(box.projectB, "b.txt"), "read", box.projectA),
        (error: unknown) =>
          error instanceof AccessDeniedError && /project isolation/i.test(error.message),
      );
    });
  } finally {
    box.cleanup();
  }
});

test("开启项目隔离但没有当前项目时 fail-closed", async () => {
  const box = sandbox();
  try {
    addAllowedRoot(box.projectA);
    writeDesktopSettings(box.agentDir, { ...defaultDesktopSettings(), projectIsolation: true });
    await withAgentDir(box.agentDir, async () => {
      await assert.rejects(
        () => authorizePath(join(box.projectA, "a.txt"), "read"),
        (error: unknown) => error instanceof AccessDeniedError,
      );
    });
  } finally {
    box.cleanup();
  }
});

test("开启项目隔离时用 Next 上报的 activeScope 兜底", async () => {
  const box = sandbox();
  try {
    addAllowedRoot(box.projectA);
    addAllowedRoot(box.projectB);
    writeDesktopSettings(box.agentDir, { ...defaultDesktopSettings(), projectIsolation: true });
    await withAgentDir(box.agentDir, async () => {
      setActiveScope(box.projectA);
      const inside = await authorizePath(join(box.projectA, "a.txt"), "read");
      assert.ok(inside.endsWith("a.txt"));
      setActiveScope(box.projectB);
      await assert.rejects(
        () => authorizePath(join(box.projectA, "a.txt"), "read"),
        (error: unknown) => error instanceof AccessDeniedError,
      );
    });
  } finally {
    box.cleanup();
  }
});
