import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  projectSettingsKey,
  readProjectSetting,
  readProjectSettings,
  resolveContextFilesEnabled,
  resolveHandoffEnabled,
  writeProjectSetting,
} from "./project-settings.ts";

function box() {
  return {
    agentDir: mkdtempSync(join(tmpdir(), "piforge-project-settings-")),
    cwd: mkdtempSync(join(tmpdir(), "piforge-project-")),
  };
}

test("writeProjectSetting 落盘并可按 cwd 读回", () => {
  const { agentDir, cwd } = box();
  assert.deepEqual(readProjectSetting(agentDir, cwd), {});
  writeProjectSetting(agentDir, cwd, { contextFiles: false });
  assert.deepEqual(readProjectSetting(agentDir, cwd), { contextFiles: false });
  const raw = JSON.parse(
    readFileSync(join(agentDir, "project-settings.json"), "utf-8"),
  ) as { projects: Record<string, { contextFiles?: boolean }> };
  assert.equal(raw.projects[projectSettingsKey(cwd)]?.contextFiles, false);
});

test("contextFiles: null 清除覆盖，空条目一并删掉", () => {
  const { agentDir, cwd } = box();
  writeProjectSetting(agentDir, cwd, { contextFiles: true });
  assert.equal(Object.keys(readProjectSettings(agentDir)).length, 1);
  writeProjectSetting(agentDir, cwd, { contextFiles: null });
  assert.deepEqual(readProjectSettings(agentDir), {});
});

test("生效值优先级：项目级 > 全局 > 默认开", () => {
  const { agentDir, cwd } = box();
  assert.equal(resolveContextFilesEnabled(agentDir, cwd), true);
  assert.equal(resolveContextFilesEnabled(agentDir, cwd, { contextFilesEnabled: false }), false);
  writeProjectSetting(agentDir, cwd, { contextFiles: true });
  assert.equal(resolveContextFilesEnabled(agentDir, cwd, { contextFilesEnabled: false }), true);
  writeProjectSetting(agentDir, cwd, { contextFiles: false });
  assert.equal(resolveContextFilesEnabled(agentDir, cwd, { contextFilesEnabled: true }), false);
});

test("HANDOFF 默认关，项目级可显式开", () => {
  const { agentDir, cwd } = box();
  assert.equal(resolveHandoffEnabled(agentDir, cwd), false);
  assert.equal(resolveHandoffEnabled(agentDir, cwd, { handoffEnabled: true }), true);
  writeProjectSetting(agentDir, cwd, { handoff: true });
  assert.equal(resolveHandoffEnabled(agentDir, cwd, { handoffEnabled: false }), true);
  writeProjectSetting(agentDir, cwd, { handoff: null });
  assert.equal(resolveHandoffEnabled(agentDir, cwd, { handoffEnabled: true }), true);
});

test("目录不存在 / 文件损坏都不抛异常", () => {
  const { agentDir } = box();
  assert.equal(
    resolveContextFilesEnabled(agentDir, join(agentDir, "not-created-yet")),
    true,
  );
  writeProjectSetting(agentDir, agentDir, { contextFiles: false });
  const path = join(agentDir, "project-settings.json");
  writeFileSync(path, "{ not json");
  assert.deepEqual(readProjectSettings(agentDir), {});
  assert.equal(resolveContextFilesEnabled(agentDir, agentDir), true);
});
