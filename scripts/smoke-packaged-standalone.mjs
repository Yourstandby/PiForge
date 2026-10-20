import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptsDir, "..");
const releaseDir = join(projectRoot, "release");

function hasStandaloneServer(path) {
  return existsSync(join(path, "server.js"));
}

function findPackagedOutput() {
  if (!existsSync(releaseDir)) return null;

  if (process.platform === "win32") {
    const outputDir = join(releaseDir, "win-unpacked");
    const standaloneDir = join(outputDir, "resources", "standalone");
    const runtimeExecutable = join(outputDir, "PiForge.exe");
    return hasStandaloneServer(standaloneDir) && existsSync(runtimeExecutable)
      ? { standaloneDir, runtimeExecutable }
      : null;
  }

  if (process.platform === "linux") {
    const outputDir = join(releaseDir, "linux-unpacked");
    const standaloneDir = join(outputDir, "resources", "standalone");
    const runtimeExecutable = ["piforge", "PiForge", "pi-agent-desktop", "Pi Agent Desktop"]
      .map((name) => join(outputDir, name))
      .find((path) => existsSync(path));
    return hasStandaloneServer(standaloneDir) && runtimeExecutable
      ? { standaloneDir, runtimeExecutable }
      : null;
  }

  if (process.platform === "darwin") {
    const macOutputs = readdirSync(releaseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^mac(?:-(?:arm64|x64|universal))?$/.test(entry.name));
    for (const output of macOutputs) {
      const macDir = join(releaseDir, output.name);
      for (const entry of readdirSync(macDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.endsWith(".app")) continue;
        const appDir = join(macDir, entry.name, "Contents");
        const standaloneDir = join(appDir, "Resources", "standalone");
        const runtimeExecutable = join(appDir, "MacOS", entry.name.slice(0, -4));
        if (hasStandaloneServer(standaloneDir) && existsSync(runtimeExecutable)) {
          return { standaloneDir, runtimeExecutable };
        }
      }
    }
  }

  return null;
}

const packagedOutput = findPackagedOutput();
if (!packagedOutput) {
  console.error(`smoke-packaged-standalone: packaged output not found under ${releaseDir}`);
  process.exit(1);
}

// The Agent Host ships inside resources/standalone: stable wrapper entry,
// compiled contract/lib tree, and the shared Pi dependency closure.
const hostEntry = join(packagedOutput.standaloneDir, "agent-host", "index.js");
const hostServer = join(packagedOutput.standaloneDir, "agent-host", "agent-host", "index.js");
const hostPackage = join(packagedOutput.standaloneDir, "agent-host", "package.json");
const piSdk = join(packagedOutput.standaloneDir, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
for (const [label, file] of [
  ["agent-host entry", hostEntry],
  ["agent-host server", hostServer],
  ["agent-host package.json", hostPackage],
  ["pi SDK runtime", piSdk],
]) {
  if (!existsSync(file)) {
    console.error(`smoke-packaged-standalone: missing ${label}: ${file}`);
    process.exit(1);
  }
}
console.log("smoke-packaged-standalone: agent-host runtime present");

const result = spawnSync(
  process.execPath,
  [
    join(scriptsDir, "smoke-standalone-server.mjs"),
    packagedOutput.standaloneDir,
    packagedOutput.runtimeExecutable,
  ],
  {
    cwd: projectRoot,
    stdio: "inherit",
    windowsHide: true,
  }
);

if (result.error) {
  console.error(`smoke-packaged-standalone: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
