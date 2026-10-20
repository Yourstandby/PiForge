#!/usr/bin/env node
/** Packaged Fleet panel: visibility refresh, hidden-window throttling, read-only DOM. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const packagedDir = process.env.PIFORGE_PACKAGED_DIR
  ? path.resolve(process.env.PIFORGE_PACKAGED_DIR)
  : path.join(repoRoot, "release", "win-unpacked");
const executable = process.platform === "win32"
  ? path.join(packagedDir, "PiForge.exe")
  : path.join(packagedDir, process.platform === "darwin" ? "PiForge.app/Contents/MacOS/PiForge" : "PiForge");
if (!existsSync(executable)) {
  console.error(`packaged-fleet-ui smoke: missing Electron executable: ${executable}`);
  process.exit(1);
}

const child = spawn(executable, [], {
  cwd: repoRoot,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, SMOKE_FLEET: "1" },
});
let output = "";
const onData = (chunk) => {
  output += chunk.toString();
  process.stdout.write(chunk);
};
child.stdout.on("data", onData);
child.stderr.on("data", onData);

try {
  const deadline = Date.now() + 90_000;
  let result = null;
  while (Date.now() < deadline) {
    const match = output.match(/SMOKE_FLEET_(OK|FAILED) ?(.*)/);
    if (match) {
      if (match[1] === "FAILED") throw new Error(`fleet UI smoke failed${String.fromCharCode(10)}${output}`);
      result = JSON.parse(match[2]);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(result, `fleet UI smoke did not finish${String.fromCharCode(10)}${output}`);
  assert.equal(result.readOnly, true, "Fleet panel must be read-only");
  assert.ok(result.afterTs > result.beforeTs, "panel must refresh after restore");
  assert.ok(["minimize", "hide"].includes(result.method));
  console.log(`packaged-fleet-ui smoke: OK ${JSON.stringify(result)}`);
} finally {
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
}
