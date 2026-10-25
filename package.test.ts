import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  scripts: Record<string, string>;
};

test("build scripts name the standalone Next.js build explicitly", () => {
  // P1-4：默认 `build:static`（静态导出）；`build:standalone` 是回退路径。
  // 两者都通过 `scripts/next-build.mjs` 调 next build（后者带 --standalone）。
  assert.match(pkg.scripts["build:standalone"], /^node scripts\/next-build\.mjs --standalone/);
  assert.match(pkg.scripts["build:static"], /^node scripts\/next-build\.mjs$/);
  assert.match(
    pkg.scripts["build:standalone"],
    /ensure-standalone-next-runtimes\.mjs/
  );
  assert.match(
    pkg.scripts["build:standalone"],
    /smoke-standalone-server\.mjs/
  );
  assert.match(
    pkg.scripts["build:standalone"],
    /ensure-standalone-pi-runtime\.mjs/
  );
  assert.match(
    pkg.scripts["build:standalone"],
    /ensure-standalone-macos-universal-runtimes\.mjs/
  );
  assert.match(
    pkg.scripts["build:standalone"],
    /dereference-standalone-symlinks\.mjs/
  );
  // `npm run build` = 默认构建。P1-4 之后默认走静态直出（`out/`），
  // standalone 只在回退/打包 node_modules 时需要（`npm run build:standalone`）。
  assert.equal(pkg.scripts.build, "npm run build:static");
});

test("packaging and release scripts call build:static + build:standalone", () => {
  assert.match(pkg.scripts.release, /npm run build:standalone/);
  // P1-4：打包需要两份产物 —— 静态直出（`out/`，装进 resources/static）与
  // standalone（只为拿到裁剪后的 node_modules + agent-host 入口）。
  // 顺序不能反：export 构建会清掉 `.next/standalone`，所以静态导出必须**先**跑，
  // standalone（产出 node_modules + agent-host 入口）压在其后（见 scripts/next-build.mjs）。
  for (const script of ["pack", "dist", "pack:mac", "dist:mac"]) {
    // static 必须在 standalone 之前，而且 mac 也要跑（漏了 out/ 时 electron-builder
    // 会直接报 `file source doesn't exist from=…/out`，v0.9.1 的 macOS 就是这么红的）。
    assert.match(pkg.scripts[script], /^npm run build:static && npm run build:standalone &&/);
    assert.match(pkg.scripts[script], /scripts\/smoke-packaged-static\.mjs/);
  }
  assert.match(
    pkg.scripts.pack,
    /electron-builder.+&& node scripts\/smoke-packaged-static\.mjs/
  );
  // dist uses the NSIS launcher (preloads the Windows Job Object workaround)
  // and still finishes with the packaged smoke.
  assert.match(pkg.scripts.dist, /node scripts\/build-installer\.mjs/);
  // 打包冒烟必须包含 standalone（Host 扩展加载）这一条：它只在 mac 的 dist 脚本里
  // 跑过，于是 v0.9.2 起的 bundle 扩展回归在 Windows / Linux 上一直是绿的。
  assert.match(pkg.scripts.dist, /&& node scripts\/smoke-packaged-standalone\.mjs$/);
  assert.match(pkg.scripts.pack, /&& node scripts\/smoke-packaged-standalone\.mjs$/);
  assert.match(pkg.scripts["pack:mac"], /electron-builder --mac --universal --dir/);
  assert.match(pkg.scripts["dist:mac"], /electron-builder --mac --universal --publish never/);
  for (const scriptName of ["pack:mac", "dist:mac"]) {
    assert.match(pkg.scripts[scriptName], /&& node scripts\/smoke-packaged-standalone\.mjs$/);
  }
  for (const scriptName of ["pack", "pack:mac", "dist", "dist:mac"]) {
    assert.doesNotMatch(
      pkg.scripts[scriptName],
      /@electron\/rebuild/,
      "electron-builder already rebuilds native dependencies",
    );
  }
});

test("test scripts cover middleware and scope platform-specific desktop subsets", () => {
  // node:test does not exit after passing (open sqlite/server handles), so both
  // scripts keep --test-force-exit. Removing it hangs the suite.
  assert.match(pkg.scripts.test, /--test-force-exit/);
  assert.match(
    pkg.scripts.test,
    /"middleware\.test\.ts"/,
    "full suite must run root middleware.test.ts"
  );
  const windowsScript = pkg.scripts["test:windows"];
  assert.ok(windowsScript, "test:windows script must exist");
  assert.match(windowsScript, /^node --test --test-force-exit /);
  assert.match(
    windowsScript,
    /"electron\/\*\*\/\*\.test\.ts"/,
    "Windows subset must include electron/**/*.test.ts"
  );
  // middleware.test.ts is a Next.js web-server concern, not a Windows-path
  // concern — it is covered by the full suite and must not run twice.
  assert.doesNotMatch(windowsScript, /middleware\.test\.ts/);

  const macosScript = pkg.scripts["test:macos"];
  assert.ok(macosScript, "test:macos script must exist");
  assert.match(macosScript, /^node --test --test-force-exit /);
  assert.match(macosScript, /"electron\/\*\*\/\*\.test\.ts"/);
  assert.match(macosScript, /"lib\/electron-\*\.test\.mjs"/);
  assert.match(
    macosScript,
    /ensure-standalone-macos-universal-runtimes\.test\.mjs/,
  );
  assert.doesNotMatch(macosScript, /middleware\.test\.ts/);
});

test("next.config tracing excludes test files from the standalone output", () => {
  const config = readFileSync(new URL("./next.config.ts", import.meta.url), "utf8");
  const block = config.slice(
    config.indexOf("outputFileTracingExcludes"),
    config.indexOf("env:")
  );
  assert.ok(block.includes("outputFileTracingExcludes"), "tracing excludes block expected");
  for (const pattern of [
    "**/*.test.ts",
    "**/*.test.tsx",
    "**/*.test.mjs",
    "**/*.test.js",
    "middleware.test.ts",
    "package.test.ts",
  ]) {
    assert.ok(block.includes(pattern), `outputFileTracingExcludes must contain ${pattern}`);
  }
});

test("packaged smoke test targets Windows and architecture-suffixed macOS outputs", () => {
  const script = readFileSync(
    new URL("./scripts/smoke-packaged-standalone.mjs", import.meta.url),
    "utf8"
  );
  assert.match(
    script,
    /join\(outputDir, "resources", "standalone"\)/
  );
  assert.match(
    script,
    /join\(outputDir, "PiForge\.exe"\)/
  );
  assert.match(script, /\^mac\(\?:-\(\?:arm64\|x64\|universal\)\)\?\$/);
  assert.match(script, /join\(appDir, "Resources", "standalone"\)/);
  assert.match(
    readFileSync(
      new URL("./scripts/smoke-standalone-server.mjs", import.meta.url),
      "utf8"
    ),
    /ELECTRON_RUN_AS_NODE/
  );
  assert.match(
    readFileSync(
      new URL("./scripts/smoke-standalone-server.mjs", import.meta.url),
      "utf8"
    ),
    /child\.once\("error"/
  );
});
