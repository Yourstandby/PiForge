/**
 * Copy the compiled Agent Host into the Next.js standalone output.
 *
 * Layout under resources/standalone:
 *
 *   agent-host/
 *     index.js                  <- stable wrapper imported by Electron Main
 *     package.json              <- { "type": "module" }
 *     agent-host/*.js           <- compiled host entry/server
 *     contract/*.js             <- compiled typed contract
 *     lib/*.js                  <- shared policy/config modules
 *   node_modules/               <- resolved by Node walking up from agent-host
 *
 * The host deliberately shares standalone/node_modules: duplicating the Pi SDK
 * closure inside agent-host/node_modules would double the installer size.
 */
import { cpSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const projectRoot = process.cwd();
const distDir = join(projectRoot, "agent-host", "dist");
const standaloneDir = join(projectRoot, ".next", "standalone");
const targetDir = join(standaloneDir, "agent-host");
const standaloneNodeModules = join(standaloneDir, "node_modules");

if (!existsSync(join(distDir, "agent-host", "index.js"))) {
  console.error("ensure-standalone-agent-host: missing agent-host/dist (run npm run build:agent-host)");
  process.exit(1);
}
if (!existsSync(standaloneDir)) {
  console.error("ensure-standalone-agent-host: .next/standalone not found (run next build)");
  process.exit(1);
}

rmSync(targetDir, { recursive: true, force: true });
cpSync(distDir, targetDir, {
  recursive: true,
  force: true,
  filter: (source) => !source.endsWith(".tsbuildinfo"),
});

// The whole tree is ESM; the nearest package.json governs every emitted file.
writeFileSync(
  join(targetDir, "package.json"),
  `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
  "utf8",
);

// Stable entry point. The nested tree keeps the original relative imports
// (../contract, ../lib) valid.
writeFileSync(join(targetDir, "index.js"), 'import "./agent-host/index.js";\n', "utf8");

const requiredHostFiles = [
  "index.js",
  "agent-host/index.js",
  "agent-host/server.js",
  "contract/protocol.js",
  "lib/path-policy.js",
  "lib/mcp-config.js",
  "lib/agent-commands.js",
  "lib/desktop-settings.js",
  "lib/project-trust-desktop.js",
];
for (const relative of requiredHostFiles) {
  if (!existsSync(join(targetDir, relative))) {
    console.error(`ensure-standalone-agent-host: missing compiled file ${relative}`);
    process.exit(1);
  }
}

const requiredPackages = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-mcp",
  "typebox",
];
for (const name of requiredPackages) {
  const manifest = join(standaloneNodeModules, ...name.split("/"), "package.json");
  if (!existsSync(manifest)) {
    console.error(`ensure-standalone-agent-host: missing runtime package ${name}`);
    process.exit(1);
  }
}

console.log("ensure-standalone-agent-host: copied Agent Host runtime and verified Pi dependencies");
