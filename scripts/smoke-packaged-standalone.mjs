import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptsDir, "..");
const releaseDir = join(projectRoot, "release");

/**
 * “这是不是一个打包产物”的判据。
 *
 * 曾经用 `standalone/server.js` 判定，但 P1-4 之后 Next 服务已经被静态直出
 * （`resources/static` + `piforge://`）取代，`server.js` **故意不进包** ——
 * `smoke-packaged-layout.mjs` 甚至断言它必须缺席。旧判据的结果就是本脚本永远
 * 报 `packaged output not found under release`（v0.9.1 的 macOS 就是卡在这里，
 * 因为只有 mac 的 dist 脚本会调它）。改用 Agent Host 入口判定。
 */
function hasAgentHostEntry(path) {
  return existsSync(join(path, "agent-host", "index.js"));
}

/** 静态直出之前的旧布局才带 server.js；现在正常不应该有。 */
function hasLegacyServer(path) {
  return existsSync(join(path, "server.js"));
}

function findPackagedOutput() {
  if (!existsSync(releaseDir)) return null;

  if (process.platform === "win32") {
    const outputDir = join(releaseDir, "win-unpacked");
    const standaloneDir = join(outputDir, "resources", "standalone");
    const runtimeExecutable = join(outputDir, "PiForge.exe");
    return hasAgentHostEntry(standaloneDir) && existsSync(runtimeExecutable)
      ? { standaloneDir, runtimeExecutable }
      : null;
  }

  if (process.platform === "linux") {
    const outputDir = join(releaseDir, "linux-unpacked");
    const standaloneDir = join(outputDir, "resources", "standalone");
    const runtimeExecutable = ["piforge", "PiForge", "pi-agent-desktop", "Pi Agent Desktop"]
      .map((name) => join(outputDir, name))
      .find((path) => existsSync(path));
    return hasAgentHostEntry(standaloneDir) && runtimeExecutable
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
        if (hasAgentHostEntry(standaloneDir) && existsSync(runtimeExecutable)) {
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

// Extension UI Bridge must survive packaging: confirm request -> response ->
// extension resumes, without the Host hanging while waiting for the renderer.
const uiBridgeStartedAt = Date.now();
const uiBridge = spawnSync(
  process.execPath,
  [join(scriptsDir, "smoke-extension-ui-bridge.mjs")],
  {
    cwd: projectRoot,
    stdio: "inherit",
    env: { ...process.env, PIFORGE_HOST_ENTRY: hostEntry },
    windowsHide: true,
  },
);
if (uiBridge.error) {
  console.error(`smoke-packaged-standalone: UI bridge smoke failed to start: ${uiBridge.error.message}`);
  process.exit(1);
}
// 耗时写进日志：CI 上到底是“卡死”还是“慢但能过”，看这一行就够。
console.log(`smoke-packaged-standalone: UI bridge smoke took ${Date.now() - uiBridgeStartedAt}ms`);
if (uiBridge.status !== 0) {
  console.error("smoke-packaged-standalone: UI bridge smoke failed");
  process.exit(uiBridge.status ?? 1);
}

const hasLegacyNextServer = hasLegacyServer(packagedOutput.standaloneDir);
if (!hasLegacyNextServer) {
  console.log(
    "smoke-packaged-standalone: standalone/server.js 未进包（静态直出布局），跳过 Node server 冒烟",
  );
  process.exit(0);
}

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
