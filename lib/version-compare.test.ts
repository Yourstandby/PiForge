import test from "node:test";
import assert from "node:assert/strict";
import { compareVersions, isPrerelease, isValidVersion, sortVersionsDesc } from "./version-compare.ts";

test("compareVersions 按 主.次.修 比较", () => {
  assert.ok(compareVersions("1.4.0", "1.1.0") > 0);
  assert.ok(compareVersions("1.1.0", "1.4.0") < 0);
  assert.equal(compareVersions("1.1.0", "1.1.0"), 0);
  assert.ok(compareVersions("1.10.0", "1.9.9") > 0);
});

test("isValidVersion 挡住 npm spec 注入", () => {
  assert.equal(isValidVersion("1.4.0"), true);
  assert.equal(isValidVersion("1.4.0-beta.2"), true);
  assert.equal(isValidVersion("1.4"), false);
  assert.equal(isValidVersion("latest"), false);
  assert.equal(isValidVersion("1.4.0 && rm -rf /"), false);
});

test("sortVersionsDesc 降序 + 去重", () => {
  assert.deepEqual(sortVersionsDesc(["1.1.0", "1.4.0", "1.1.0", "1.10.0"]), ["1.10.0", "1.4.0", "1.1.0"]);
});

test("isPrerelease 识别预发布", () => {
  assert.equal(isPrerelease("1.4.0-beta.1"), true);
  assert.equal(isPrerelease("1.4.0"), false);
});
