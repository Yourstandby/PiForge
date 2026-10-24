import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { minimatch } from "minimatch";
import {
  missingFromBuilderConfig,
  missingFromNodeModules,
} from "./electron-updater-runtime-deps.mjs";

const config = readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

test("electron-builder.yml is not missing any required updater runtime packages", () => {
  assert.deepEqual(missingFromBuilderConfig(config), []);
});

test("electron-updater runtime packages resolve from project node_modules", () => {
  assert.deepEqual(missingFromNodeModules(projectRoot), []);
});

/**
 * 把 `extraResources:` 拆成条目，每条含 from / to / filter 列表。
 *
 * 为什么不再硬编码某一段文本：P1-4 之后安装包**不再包含 Next standalone 运行时**
 * （`- from: .next/standalone` 整个目录被移除，只留 `agent-host` 与 `node_modules`），
 * 旧断言 `indexOf("- from: .next/standalone\n")` 于是永远为 -1，报出
 * 「standalone extraResources entry expected」。这是**测试锚点过期**，不是配置坏了。
 */
function extraResourcesEntries(source) {
  const start = source.search(/^extraResources:$/m);
  assert.notEqual(start, -1, "extraResources block expected");
  const rest = source.slice(start);
  // 先跳过 `extraResources:` 这一行，再找下一个缩进为 0 的顶层键
  const body = rest.slice(rest.indexOf(String.fromCharCode(10)) + 1);
  const endMatch = body.search(/^\S/m);
  const block = endMatch === -1 ? body : body.slice(0, endMatch);
  const entries = [];
  for (const chunk of block.split(/\n  - from: /).slice(1)) {
    const [fromLine, ...tail] = chunk.split("\n");
    const trimmed = tail.map((line) => line.trim());
    const filters = trimmed
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2).replace(/^"|"$/g, ""));
    const to = trimmed.find((line) => line.startsWith("to: "));
    entries.push({ from: fromLine.trim(), to: to ? to.slice(4).trim() : null, filters });
  }
  assert.ok(entries.length > 0, "extraResources must contain at least one entry");
  return entries;
}

/** 承载**本仓库自有代码**的入口：必须排除测试文件。 */
const OWN_CODE_SOURCES = ["out", ".next/standalone/agent-host"];
const TEST_FILTERS = ["!**/*.test.ts", "!**/*.test.tsx", "!**/*.test.mjs", "!**/*.test.js"];

test("every extraResources entry shipping our own code excludes test files", () => {
  const entries = extraResourcesEntries(config);
  for (const from of OWN_CODE_SOURCES) {
    const entry = entries.find((candidate) => candidate.from === from);
    assert.ok(entry, `extraResources entry "from: ${from}" expected`);
    for (const pattern of TEST_FILTERS) {
      assert.ok(
        entry.filters.includes(pattern),
        `${from} filter must contain ${pattern}（实际：${JSON.stringify(entry.filters)}）`
      );
    }
  }
});

test("installer no longer ships a Next standalone runtime (P1-4 static export)", () => {
  const froms = extraResourcesEntries(config).map((entry) => entry.from);
  // 整个 .next/standalone 目录曾经被打进安装包（server.js + .next + public）。
  assert.equal(
    froms.includes(".next/standalone"),
    false,
    "静态直出后不应再打包整个 .next/standalone（只留 agent-host 与依赖树）"
  );
  // 但依赖树与 Host 仍然必须打进去，否则 Host 起不来。
  assert.ok(froms.includes(".next/standalone/node_modules"), "standalone/node_modules must be packaged");
  assert.ok(froms.includes(".next/standalone/agent-host"), "standalone/agent-host must be packaged");
});

test("build output excludes test files (tsconfig, so tests never reach dist/)", () => {
  for (const tsconfig of ["../agent-host/tsconfig.json", "../electron/tsconfig.json"]) {
    const parsed = JSON.parse(readFileSync(new URL(tsconfig, import.meta.url), "utf8"));
    const exclude = (parsed.exclude ?? []).join(" ");
    assert.match(exclude, /\.test\.ts/, `${tsconfig} must exclude test files`);
  }
});
test("update feed is pinned to the GitHub Releases repository", () => {
  const start = config.search(/^publish:$/m);
  assert.notEqual(start, -1, "publish block expected");
  const block = config.slice(start);
  assert.match(block, /provider: github/);
  assert.match(block, /owner: Yourstandby/);
  assert.match(block, /repo: PiForge/);
  assert.doesNotMatch(block, /\$\{/, "feed must not depend on runtime/template values");
});

test("Windows packaging emits NSIS and ZIP for the updater feed", () => {
  const start = config.search(/^win:$/m);
  const end = config.search(/^nsis:$/m);
  assert.ok(start !== -1 && end > start, "win settings expected before nsis");
  const block = config.slice(start, end);
  assert.match(block, /- target: nsis/);
  assert.match(block, /- target: zip/);
  assert.match(block, /artifactName: "PiForge-\$\{version\}-win-\$\{arch\}\.\$\{ext\}"/);
});

test("macOS packaging emits universal DMG and ZIP artifacts", () => {
  assert.match(config, /mac:\n[\s\S]*?target: dmg[\s\S]*?- universal/);
  assert.match(config, /mac:\n[\s\S]*?target: zip[\s\S]*?- universal/);
  assert.match(config, /icon: build\/icon\.icns/);
  assert.match(config, /category: public\.app-category\.developer-tools/);
  assert.match(config, /artifactName: "PiForge-\$\{version\}-mac-\$\{arch\}\.\$\{ext\}"/);
  assert.doesNotMatch(
    config,
    /^electronDist:/m,
    "a host-only electronDist prevents universal packaging from downloading both architectures",
  );
});

test("Linux packaging emits a deb artifact", () => {
  assert.match(config, /linux:\n[\s\S]*?target: deb/);
  assert.match(config, /icon: build\/icon\.png/);
  assert.match(config, /category: Development/);
  assert.match(config, /executableName: piforge/);
  assert.match(config, /artifactName: "PiForge-\$\{version\}-linux-\$\{arch\}\.\$\{ext\}"/);
});

test("Universal merge skips lipo only for architecture-specific runtime paths", () => {
  const match = config.match(/^\s*x64ArchFiles: "([^"]+)"$/m);
  assert.ok(match, "mac.x64ArchFiles pattern expected");
  const pattern = match[1];
  for (const path of [
    "Contents/Resources/standalone/node_modules/@esbuild/darwin-arm64/bin/esbuild",
    "Contents/Resources/standalone/node_modules/@esbuild/darwin-x64/bin/esbuild",
    "Contents/Resources/standalone/node_modules/@earendil-works/pi-tui/native/darwin/prebuilds/darwin-arm64/darwin-modifiers.node",
    "Contents/Resources/standalone/node_modules/@earendil-works/pi-tui/native/darwin/prebuilds/darwin-x64/darwin-modifiers.node",
    "Contents/Resources/standalone/node_modules/@img/sharp-darwin-arm64/lib/sharp.node",
    "Contents/Resources/standalone/node_modules/@img/sharp-darwin-x64/lib/sharp.node",
    "Contents/Resources/standalone/node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips.dylib",
    "Contents/Resources/standalone/node_modules/@img/sharp-libvips-darwin-x64/lib/libvips.dylib",
    "Contents/Resources/standalone/.next/node_modules/@earendil-works/pi-coding-agent-4cdde81112ef3dc5/node_modules/@mariozechner/clipboard-darwin-arm64/clipboard.darwin-arm64.node",
  ]) {
    assert.ok(minimatch(path, pattern), `${path} must match x64ArchFiles`);
  }
  assert.equal(
    minimatch(
      "Contents/MacOS/PiForge",
      pattern,
    ),
    false,
    "the Electron executable must still be merged with lipo",
  );
});
