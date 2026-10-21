import assert from "node:assert/strict";
import test from "node:test";
import { normalizeProjectPath, projectTint } from "./project-color.ts";
import { projectKey } from "../components/session-sidebar/projects.ts";

test("the same folder renders the same tint regardless of spelling", () => {
  const canonical = projectTint("D:/Pi/PiForge");
  assert.equal(projectTint("D:\\Pi\\PiForge"), canonical);
  assert.equal(projectTint("D:\\Pi\\PiForge\\"), canonical);
  assert.equal(projectTint("d:/pi/piforge"), canonical);
  assert.equal(projectTint("  D:/Pi/PiForge/  "), canonical);
});

test("sidebar grouping key and tint share one normalization", () => {
  for (const cwd of ["D:\\Pi\\PiForge\\", "d:/pi/piforge", "/home/me/repo/", ""]) {
    assert.equal(projectKey(cwd), normalizeProjectPath(cwd), cwd);
  }
});

test("different folders can map to different tints", () => {
  const tints = new Set(
    ["D:/alpha", "D:/beta", "D:/gamma", "/home/me/repo", "//wsl.localhost/Ubuntu/home"].map(
      (cwd) => projectTint(cwd),
    ),
  );
  assert.ok(tints.size > 1, "expected more than one tint across distinct projects");
});

test("unknown cwd falls back instead of throwing", () => {
  assert.match(projectTint(null), /^#[0-9A-F]{6}$/i);
  assert.match(projectTint(undefined), /^#[0-9A-F]{6}$/i);
  assert.match(projectTint(""), /^#[0-9A-F]{6}$/i);
});
