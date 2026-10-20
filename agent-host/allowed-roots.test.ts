import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addAllowedRoot,
  getAllowedRoots,
  isPathAllowed,
} from "./allowed-roots.ts";

test("allowed roots are canonicalized (macOS /var → /private/var)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-allowed-root-"));
  try {
    addAllowedRoot(dir);
    const roots = await getAllowedRoots();
    assert.ok(roots.has(await realpath(dir)), "root must be stored as its realpath");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runner-like paths are not implicitly allowed", () => {
  const base = mkdtempSync(join(tmpdir(), "pi-runner-"));
  try {
    mkdirSync(join(base, "runner"));
    assert.equal(
      isPathAllowed(join(base, "runner", "secret.txt"), new Set([join(base, "allowed")])),
      false,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
