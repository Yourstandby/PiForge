import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  RECOMMENDED_DEFAULT_THINKING_LEVEL,
  ensureRecommendedPiSettings,
} from "./settings-defaults.ts";

function withAgentDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "pi-settings-defaults-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("缺失的 defaultThinkingLevel 补写成 low", () => {
  withAgentDir((dir) => {
    const result = ensureRecommendedPiSettings(dir);
    assert.deepEqual(result.written, ["defaultThinkingLevel"]);
    const written = JSON.parse(readFileSync(join(dir, "settings.json"), "utf-8"));
    assert.equal(written.defaultThinkingLevel, RECOMMENDED_DEFAULT_THINKING_LEVEL);
    assert.equal(RECOMMENDED_DEFAULT_THINKING_LEVEL, "low");
  });
});

test("用户已设置的思考等级不会被覆盖（连值、其它键一起保持）", () => {
  withAgentDir((dir) => {
    const path = join(dir, "settings.json");
    const original = { defaultThinkingLevel: "high", hideThinkingBlock: true };
    writeFileSync(path, JSON.stringify(original), "utf-8");

    const result = ensureRecommendedPiSettings(dir);
    assert.deepEqual(result.written, []);
    assert.equal(result.skipped, "exists");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf-8")), original);
  });
});

test("补写只加一个键，不动用户已有的其它设置", () => {
  withAgentDir((dir) => {
    const path = join(dir, "settings.json");
    const original = { defaultTools: ["read", "bash"], codemode: { mode: "on" } };
    writeFileSync(path, JSON.stringify(original), "utf-8");

    ensureRecommendedPiSettings(dir);
    const written = JSON.parse(readFileSync(path, "utf-8"));
    assert.equal(written.defaultThinkingLevel, "low");
    assert.deepEqual(written.defaultTools, original.defaultTools);
    assert.deepEqual(written.codemode, original.codemode);
  });
});

test("解析失败 / 内容非对象时放弃写，不破坏用户文件", () => {
  withAgentDir((dir) => {
    const path = join(dir, "settings.json");
    writeFileSync(path, "{ not json", "utf-8");
    assert.equal(ensureRecommendedPiSettings(dir).skipped, "unreadable");
    assert.equal(readFileSync(path, "utf-8"), "{ not json");

    writeFileSync(path, "[]", "utf-8");
    assert.equal(ensureRecommendedPiSettings(dir).skipped, "not-an-object");
    assert.equal(readFileSync(path, "utf-8"), "[]");
  });
});
