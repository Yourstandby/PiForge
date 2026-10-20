#!/usr/bin/env node
/**
 * Write SHA256SUMS.txt for the current version's Windows release assets
 * (NSIS installer + ZIP). Usage: node scripts/write-sha256.mjs [releaseDir]
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function collectWindowsAssets(dir, version) {
  const names = readdirSync(dir)
    .filter(
      (name) =>
        name === `PiForge-Setup-${version}.exe` ||
        name === `PiForge-${version}-win-x64.zip`,
    )
    .sort();
  return names;
}

export function writeChecksums(dir, version) {
  const names = collectWindowsAssets(dir, version);
  if (names.length !== 2) {
    throw new Error(`Expected NSIS .exe + win ZIP for ${version}, found ${names.length}: ${names.join(", ")}`);
  }
  const lines = names.map((name) => {
    const digest = createHash("sha256").update(readFileSync(join(dir, name))).digest("hex");
    return `${digest}  ${name}`;
  });
  const out = join(dir, "SHA256SUMS.txt");
  writeFileSync(out, `${lines.join("\n")}\n`);
  return { out, lines };
}

function main() {
  const dir = process.argv[2] ?? "release";
  const { version } = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
  try {
    const { out, lines } = writeChecksums(dir, version);
    console.log(`Wrote ${out}`);
    console.log(lines.join("\n"));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
