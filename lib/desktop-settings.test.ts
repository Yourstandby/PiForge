import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  defaultDesktopSettings,
  mergeDesktopSettings,
  readDesktopSettings,
  validateDesktopSettingsBody,
  writeDesktopSettings,
} from "./desktop-settings.ts";

test("defaultDesktopSettings is full + default tools", () => {
  const d = defaultDesktopSettings();
  assert.equal(d.defaultAgentMode, "full");
  assert.equal(d.defaultToolPreset, "default");
});

test("mergeDesktopSettings ignores invalid fields", () => {
  const m = mergeDesktopSettings({
    defaultAgentMode: "nope",
    defaultToolPreset: "full",
  });
  assert.equal(m.defaultAgentMode, "full");
  assert.equal(m.defaultToolPreset, "full");
});

test("read/write round-trip on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-desktop-settings-"));
  try {
    const written = writeDesktopSettings(dir, {
      defaultAgentMode: "plan",
      defaultToolPreset: "full",
    });
    assert.equal(written.defaultAgentMode, "plan");
    const read = readDesktopSettings(dir);
    assert.deepEqual(read, written);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readDesktopSettings missing file returns defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-desktop-settings-empty-"));
  try {
    assert.deepEqual(readDesktopSettings(dir), defaultDesktopSettings());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validateDesktopSettingsBody", () => {
  assert.equal(validateDesktopSettingsBody({ defaultAgentMode: "ask" }), null);
  assert.match(validateDesktopSettingsBody(null)!, /object/);
  assert.match(validateDesktopSettingsBody({ defaultAgentMode: "x" })!, /defaultAgentMode/);
  assert.match(validateDesktopSettingsBody({ codemodeEnabled: "yes" })!, /codemodeEnabled/);
  assert.equal(validateDesktopSettingsBody({ codemodeEnabled: true }), null);
  assert.equal(validateDesktopSettingsBody({ codemodeMode: "only" }), null);
  assert.match(validateDesktopSettingsBody({ codemodeMode: "off" })!, /codemodeMode/);
  // worker 池：1–8 的整数，`null` 是显式「跟随环境」。
  assert.equal(validateDesktopSettingsBody({ codemodeMaxWorkers: 4 }), null);
  assert.equal(validateDesktopSettingsBody({ codemodeMaxWorkers: 1 }), null);
  assert.equal(validateDesktopSettingsBody({ codemodeMaxWorkers: 8 }), null);
  assert.equal(validateDesktopSettingsBody({ codemodeMaxWorkers: null }), null);
  assert.match(validateDesktopSettingsBody({ codemodeMaxWorkers: 0 })!, /codemodeMaxWorkers/);
  assert.match(validateDesktopSettingsBody({ codemodeMaxWorkers: 9 })!, /codemodeMaxWorkers/);
  assert.match(validateDesktopSettingsBody({ codemodeMaxWorkers: 2.5 })!, /codemodeMaxWorkers/);
  assert.match(validateDesktopSettingsBody({ codemodeMaxWorkers: "4" })!, /codemodeMaxWorkers/);
});

test("Codemode defaults on with tools declared normally", () => {
  const defaults = defaultDesktopSettings();
  assert.equal(defaults.codemodeEnabled, true);
  // 默认 `on`：工具逐条声明，脚本只是第二种调用方式（`only` 会让界面在长脚本期间空转）。
  assert.equal(defaults.codemodeMode, "on");
  // 池大小默认不落盘：交给 PI_CODEMODE_MAX_WORKERS / SDK 的 2。
  assert.equal(defaults.codemodeMaxWorkers, undefined);

  // Invalid mode falls back to the default instead of silently dropping the field.
  assert.equal(mergeDesktopSettings({ codemodeMode: "nope" }).codemodeMode, "on");
  // 老用户显式写过的 `only` 不被默认值覆盖。
  assert.equal(mergeDesktopSettings({ codemodeMode: "only" }).codemodeMode, "only");
  // Explicit opt-out still wins over the new default.
  assert.equal(mergeDesktopSettings({ codemodeEnabled: false }).codemodeEnabled, false);

  // 显式池大小保留；`null` 清掉字段回到跟随环境；非法值不落盘。
  assert.equal(mergeDesktopSettings({ codemodeMaxWorkers: 4 }).codemodeMaxWorkers, 4);
  assert.equal(mergeDesktopSettings({ codemodeMaxWorkers: null }).codemodeMaxWorkers, undefined);
  assert.equal(mergeDesktopSettings({ codemodeMaxWorkers: 42 }).codemodeMaxWorkers, undefined);

  const dir = mkdtempSync(join(tmpdir(), "pi-desktop-codemode-"));
  try {
    const saved = writeDesktopSettings(dir, {
      defaultAgentMode: "ask",
      defaultToolPreset: "full",
      codemodeEnabled: false,
      codemodeMode: "on",
      ltm: { enabled: false },
    });
    assert.deepEqual(readDesktopSettings(dir), saved);
    assert.equal(saved.codemodeEnabled, false);
    assert.equal(saved.codemodeMode, "on");
    assert.equal(saved.ltm?.enabled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeDesktopSettings merges nested ltm", () => {
  const m = mergeDesktopSettings({
    defaultAgentMode: "full",
    ltm: {
      enabled: false,
      observeAgentEnd: false,
    },
  });
  assert.equal(m.defaultAgentMode, "full");
  assert.deepEqual(m.ltm, {
    enabled: false,
    observeAgentEnd: false,
  });
});

test("read/write round-trip preserves nested ltm", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-desktop-settings-ltm-"));
  try {
    const written = writeDesktopSettings(dir, {
      defaultAgentMode: "ask",
      defaultToolPreset: "default",
      ltm: { enabled: false, dbPath: "C:/tmp/ltm.sqlite" },
    });
    assert.equal(written.ltm?.enabled, false);
    const read = readDesktopSettings(dir);
    assert.deepEqual(read.ltm, written.ltm);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Auto routing model selections merge, validate and clear", () => {
  const merged = mergeDesktopSettings({
    autoRoutingFast: { provider: "deepseek", modelId: "deepseek-flash" },
    autoRoutingStrong: { provider: "deepseek", modelId: "deepseek-v4-pro" },
  });
  assert.deepEqual(merged.autoRoutingFast, {
    provider: "deepseek",
    modelId: "deepseek-flash",
  });
  assert.deepEqual(merged.autoRoutingStrong, {
    provider: "deepseek",
    modelId: "deepseek-v4-pro",
  });

  assert.equal(
    validateDesktopSettingsBody({
      autoRoutingFast: { provider: "p", modelId: "m" },
      autoRoutingStrong: null,
    }),
    null,
  );
  assert.match(
    validateDesktopSettingsBody({ autoRoutingFast: { provider: "", modelId: "m" } })!,
    /autoRoutingFast\.provider/,
  );

  const cleared = mergeDesktopSettings({
    ...merged,
    autoRoutingFast: null,
  });
  assert.equal(cleared.autoRoutingFast, undefined);
});

test("auxiliary image/decision model selections merge, validate and clear", () => {
  const merged = mergeDesktopSettings({
    imageModel: { provider: "openrouter", modelId: "black-forest-labs/flux.2-pro" },
    decisionModel: { provider: "openai", modelId: "gpt-6-luna" },
  });
  assert.deepEqual(merged.imageModel, {
    provider: "openrouter",
    modelId: "black-forest-labs/flux.2-pro",
  });
  assert.deepEqual(merged.decisionModel, { provider: "openai", modelId: "gpt-6-luna" });

  assert.equal(
    validateDesktopSettingsBody({
      imageModel: { provider: "p", modelId: "m" },
      decisionModel: null,
    }),
    null,
  );
  assert.match(
    validateDesktopSettingsBody({ decisionModel: { provider: "", modelId: "m" } })!,
    /decisionModel\.provider/,
  );
  assert.match(
    validateDesktopSettingsBody({ imageModel: { provider: "p", modelId: "" } })!,
    /imageModel\.modelId/,
  );

  const cleared = mergeDesktopSettings({ ...merged, imageModel: null });
  assert.equal(cleared.imageModel, undefined);
  assert.deepEqual(cleared.decisionModel, merged.decisionModel);
});

test("browser permissions default to off and persist booleans", () => {
  const defaults = defaultDesktopSettings();
  assert.equal(defaults.browserReadEnabled, false);
  assert.equal(defaults.browserInteractEnabled, false);

  const merged = mergeDesktopSettings({
    browserReadEnabled: true,
    browserInteractEnabled: "yes",
  });
  assert.equal(merged.browserReadEnabled, true);
  // Invalid values fall back to the safe default (off).
  assert.equal(merged.browserInteractEnabled, false);

  assert.equal(
    validateDesktopSettingsBody({ browserReadEnabled: true, browserInteractEnabled: false }),
    null,
  );
  assert.match(
    validateDesktopSettingsBody({ browserReadEnabled: "yes" })!,
    /browserReadEnabled/,
  );
  assert.match(
    validateDesktopSettingsBody({ browserInteractEnabled: 1 })!,
    /browserInteractEnabled/,
  );

  const dir = mkdtempSync(join(tmpdir(), "pi-browser-permissions-"));
  try {
    writeDesktopSettings(dir, { ...defaults, browserReadEnabled: true });
    const read = readDesktopSettings(dir);
    assert.equal(read.browserReadEnabled, true);
    assert.equal(read.browserInteractEnabled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collab guidelines default on, persist as a boolean and reject other types", () => {
  const defaults = defaultDesktopSettings();
  assert.equal(defaults.collabGuidelines, undefined, "未设置时按默认开处理");

  const off = mergeDesktopSettings({ collabGuidelines: false });
  assert.equal(off.collabGuidelines, false);
  const garbage = mergeDesktopSettings({ collabGuidelines: "off" });
  assert.equal(garbage.collabGuidelines, undefined, "非布尔值直接忽略");

  assert.equal(validateDesktopSettingsBody({ collabGuidelines: true }), null);
  assert.match(validateDesktopSettingsBody({ collabGuidelines: 0 })!, /collabGuidelines/);

  const dir = mkdtempSync(join(tmpdir(), "pi-collab-guidelines-"));
  try {
    writeDesktopSettings(dir, { ...defaults, collabGuidelines: false });
    assert.equal(readDesktopSettings(dir).collabGuidelines, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("onDemandDomains round-trips through the settings file", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-desktop-settings-"));
  try {
    const written = writeDesktopSettings(dir, {
      defaultAgentMode: "full",
      defaultToolPreset: "default",
      onDemandDomains: ["shell", "browser"],
    });
    assert.deepEqual(written.onDemandDomains, ["shell", "browser"]);
    const read = readDesktopSettings(dir);
    assert.deepEqual(read.onDemandDomains, ["shell", "browser"]);
    // 空数组 = 显式「全部常驻」，必须保留（而不是当成未设置）
    writeDesktopSettings(dir, { defaultAgentMode: "full", defaultToolPreset: "default", onDemandDomains: [] });
    assert.deepEqual(readDesktopSettings(dir).onDemandDomains, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("onDemandDomains drops unknown names and rejects malformed input", () => {
  assert.deepEqual(mergeDesktopSettings({ onDemandDomains: ["shell", "nope"] }).onDemandDomains, ["shell"]);
  assert.equal(validateDesktopSettingsBody({ onDemandDomains: "shell" }), "onDemandDomains must be an array of strings");
  assert.match(
    validateDesktopSettingsBody({ onDemandDomains: ["nope"] }) ?? "",
    /onDemandDomains only accepts/
  );
  assert.equal(validateDesktopSettingsBody({ onDemandDomains: ["shell"] }), null);
});
