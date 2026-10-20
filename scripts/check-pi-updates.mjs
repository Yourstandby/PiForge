#!/usr/bin/env node
/**
 * Pi upgrade radar.
 *
 * Reads the exact @earendil-works versions pinned in package.json, asks the
 * npm registry for the latest release, and prints an actionable report.
 * Exits 0 even when updates exist: this is a report, not a release gate.
 */
import { readFileSync } from "node:fs";

const PI_SCOPE = "@earendil-works/";
const registry = process.env.NPM_REGISTRY_URL?.replace(/\/+$/, "") || "https://registry.npmjs.org";

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return 0;
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

function exactSpec(spec) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(spec) ? spec : spec.replace(/^[~^<>=\s]+/, "");
}

async function fetchLatest(name) {
  const url = `${registry}/${name.replace("/", "%2F")}`;
  const response = await fetch(url, {
    headers: { accept: "application/vnd.npm.install-v1+json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  return body["dist-tags"]?.latest ?? null;
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const entries = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })
  .filter(([name]) => name.startsWith(PI_SCOPE))
  .sort(([a], [b]) => a.localeCompare(b));

if (entries.length === 0) {
  console.error(`No ${PI_SCOPE} dependencies found in package.json`);
  process.exit(1);
}

const rows = [];
let updates = 0;
for (const [name, spec] of entries) {
  const current = exactSpec(spec);
  try {
    const latest = await fetchLatest(name);
    const update = latest ? compareVersions(latest, current) > 0 : false;
    if (update) updates += 1;
    rows.push({ name, current, latest: latest ?? "unknown", status: update ? "UPDATE" : "current" });
  } catch (error) {
    rows.push({ name, current, latest: "unavailable", status: `ERROR: ${error instanceof Error ? error.message : String(error)}` });
  }
}

console.log(`Pi dependency report (${new Date().toISOString()})`);
console.log(`Registry: ${registry}`);
for (const row of rows) {
  console.log(`  ${row.status === "UPDATE" ? "↑" : row.status === "current" ? "✓" : "!"} ${row.name}`);
  console.log(`      pinned ${row.current} · latest ${row.latest} · ${row.status}`);
}
console.log(updates > 0
  ? `\n${updates} update(s) available. Review the SDK adapter boundary before bumping.`
  : "\nAll pinned Pi packages are current.");
