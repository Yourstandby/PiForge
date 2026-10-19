import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePorcelainZ } from "./git-status.ts";

test("parsePorcelainZ reads modified and untracked entries", () => {
  const output = " M src/app.tsx\0?? notes.md\0A  lib/new.ts\0";
  assert.deepEqual(parsePorcelainZ(output), [
    { path: "src/app.tsx", status: " M" },
    { path: "notes.md", status: "??" },
    { path: "lib/new.ts", status: "A " },
  ]);
});

test("parsePorcelainZ skips the original path of a rename", () => {
  const output = "R  src/new-name.ts\0src/old-name.ts\0 M docs/readme.md\0";
  assert.deepEqual(parsePorcelainZ(output), [
    { path: "src/new-name.ts", status: "R " },
    { path: "docs/readme.md", status: " M" },
  ]);
});
