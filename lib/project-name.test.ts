import test from "node:test";
import assert from "node:assert/strict";
import { projectNameFromCwd } from "./project-name.ts";

test("projectNameFromCwd returns the last Windows path segment", () => {
  assert.equal(projectNameFromCwd("D:\\Pi\\PiForge"), "PiForge");
  assert.equal(projectNameFromCwd("C:\\Users\\Luo Wei"), "Luo Wei");
});

test("projectNameFromCwd handles POSIX paths and trailing separators", () => {
  assert.equal(projectNameFromCwd("/home/dev/pi-forge"), "pi-forge");
  assert.equal(projectNameFromCwd("/home/dev/pi-forge/"), "pi-forge");
  assert.equal(projectNameFromCwd("D:\\Pi\\PiForge\\\\"), "PiForge");
});

test("projectNameFromCwd keeps drive roots readable", () => {
  assert.equal(projectNameFromCwd("D:\\"), "D:");
  assert.equal(projectNameFromCwd("C:/"), "C:");
});

test("projectNameFromCwd returns null for empty input", () => {
  assert.equal(projectNameFromCwd(null), null);
  assert.equal(projectNameFromCwd(undefined), null);
  assert.equal(projectNameFromCwd(""), null);
  assert.equal(projectNameFromCwd("   "), null);
  assert.equal(projectNameFromCwd("\\"), null);
});
