#!/usr/bin/env node
/**
 * Adapter boundary guard.
 *
 * Only agent-host/sdk-adapter.ts may import @earendil-works/* directly.
 * Keeping this check in CI makes the upgrade seam enforceable, not a style
 * convention that drifts on the next feature branch.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const AGENT_HOST = join(process.cwd(), "agent-host");
const ADAPTER = join(AGENT_HOST, "sdk-adapter.ts");
const violations = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === "dist" || entry === "node_modules") continue;
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full);
      continue;
    }
    if (!/\.(?:ts|tsx|js|mjs)$/.test(entry) || full === ADAPTER) continue;
    const source = readFileSync(full, "utf8");
    const matches = source.matchAll(/from\s+["'](@earendil-works\/[^"']+)["']|import\(\s*["'](@earendil-works\/[^"']+)["']\s*\)/g);
    for (const match of matches) {
      violations.push(`${relative(process.cwd(), full)}: ${match[1] ?? match[2]}`);
    }
  }
}

walk(AGENT_HOST);

if (violations.length > 0) {
  console.error("SDK adapter boundary violation(s):");
  for (const violation of violations) console.error(`  - ${violation}`);
  console.error("\nMove the import into agent-host/sdk-adapter.ts and import the adapter instead.");
  process.exit(1);
}

console.log(`sdk-adapter boundary: OK (${relative(process.cwd(), ROOT)} scanned)`);
