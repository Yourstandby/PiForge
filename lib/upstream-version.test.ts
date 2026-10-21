import test from "node:test";
import assert from "node:assert/strict";
import { compareVersions, readLocalPiVersion } from "./upstream-version.ts";

test("compareVersions orders semver cores", () => {
  assert.ok(compareVersions("1.3.0", "1.1.0") > 0);
  assert.ok(compareVersions("1.1.0", "1.3.0") < 0);
  assert.equal(compareVersions("1.1.0", "1.1.0"), 0);
  assert.ok(compareVersions("1.10.0", "1.9.9") > 0);
});

test("readLocalPiVersion returns installed SDK version", () => {
  const version = readLocalPiVersion();
  assert.match(version, /^\d+\.\d+\.\d+/);
});
