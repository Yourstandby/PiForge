#!/usr/bin/env node
/**
 * electron-builder launcher with the Windows NSIS Job Object workaround
 * preloaded. Keeps `npm run dist` cross-platform: the patch is a no-op outside
 * Windows.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(projectRoot, "node_modules", "electron-builder", "out", "cli", "cli.js");
const patch = join(projectRoot, "scripts", "patch-nsis-job-object.cjs");
if (!existsSync(cli)) {
  console.error(`electron-builder CLI not found: ${cli}`);
  process.exit(1);
}

const existingNodeOptions = process.env.NODE_OPTIONS?.trim();
const nodeOptions = [existingNodeOptions, `--require=${patch}`].filter(Boolean).join(" ");
const result = spawnSync(process.execPath, [cli, "--publish", "never", ...process.argv.slice(2)], {
  cwd: projectRoot,
  stdio: "inherit",
  env: { ...process.env, NODE_OPTIONS: nodeOptions },
});
if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
