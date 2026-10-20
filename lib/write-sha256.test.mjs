import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectWindowsAssets, writeChecksums } from "../scripts/write-sha256.mjs";

test("checksums cover the current NSIS installer and win x64 ZIP only", () => {
  const dir = mkdtempSync(join(tmpdir(), "piforge-sha-"));
  try {
    writeFileSync(join(dir, "PiForge-Setup-0.5.0.exe"), "exe");
    writeFileSync(join(dir, "PiForge-0.5.0-win-x64.zip"), "zip");
    writeFileSync(join(dir, "PiForge-0.5.0-win-ia32.zip"), "other");
    writeFileSync(join(dir, "PiForge-Setup-0.3.0.exe"), "old");
    assert.deepEqual(collectWindowsAssets(dir, "0.5.0"), [
      "PiForge-0.5.0-win-x64.zip",
      "PiForge-Setup-0.5.0.exe",
    ]);
    const { lines } = writeChecksums(dir, "0.5.0");
    assert.equal(lines.length, 2);
    const text = readFileSync(join(dir, "SHA256SUMS.txt"), "utf8");
    assert.match(text, /^[0-9a-f]{64} {2}PiForge-0\.5\.0-win-x64\.zip$/m);
    assert.match(text, /^[0-9a-f]{64} {2}PiForge-Setup-0\.5\.0\.exe$/m);
    assert.doesNotMatch(text, /ia32|0\.3\.0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checksums fail loudly when an artifact is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "piforge-sha-"));
  try {
    writeFileSync(join(dir, "PiForge-Setup-0.5.0.exe"), "exe");
    assert.throws(() => writeChecksums(dir, "0.5.0"), /Expected NSIS \.exe \+ win ZIP/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
