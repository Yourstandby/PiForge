import assert from "node:assert/strict";
import test from "node:test";
import { requiredDarwinSharpPackages, requiredDarwinEsbuildPackages } from "./ensure-standalone-macos-universal-runtimes.mjs";

test("selects both macOS esbuild binaries at the JavaScript API version", () => {
  assert.deepEqual(requiredDarwinEsbuildPackages({
    version: "0.28.2",
    optionalDependencies: {
      "@esbuild/darwin-arm64": "0.28.2",
      "@esbuild/darwin-x64": "0.28.2",
      "@esbuild/linux-x64": "0.28.2",
    },
  }), [
    { name: "@esbuild/darwin-arm64", version: "0.28.2" },
    { name: "@esbuild/darwin-x64", version: "0.28.2" },
  ]);
  assert.throws(() => requiredDarwinEsbuildPackages({
    version: "0.28.2",
    optionalDependencies: { "@esbuild/darwin-arm64": "0.28.1" },
  }), /expected esbuild optional dependency/);
});

test("selects both macOS architectures from Sharp optional dependencies", () => {
  const packages = requiredDarwinSharpPackages({
    optionalDependencies: {
      "@img/sharp-linux-x64": "0.35.3",
      "@img/sharp-libvips-darwin-x64": "1.3.2",
      "@img/sharp-darwin-arm64": "0.35.3",
      "@img/sharp-darwin-x64": "0.35.3",
      "@img/sharp-libvips-darwin-arm64": "1.3.2",
    },
  });

  assert.deepEqual(packages, [
    { name: "@img/sharp-darwin-arm64", version: "0.35.3" },
    { name: "@img/sharp-darwin-x64", version: "0.35.3" },
    { name: "@img/sharp-libvips-darwin-arm64", version: "1.3.2" },
    { name: "@img/sharp-libvips-darwin-x64", version: "1.3.2" },
  ]);
});

test("fails closed when Sharp's macOS optional dependency set changes", () => {
  assert.throws(
    () =>
      requiredDarwinSharpPackages({
        optionalDependencies: {
          "@img/sharp-darwin-arm64": "0.35.3",
        },
      }),
    /expected Sharp optional dependencies/,
  );
});

test("esbuild is optional: a standalone bundle without it no longer throws ENOENT", async () => {
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { readOptionalEsbuildManifest } = await import("./ensure-standalone-macos-universal-runtimes.mjs");

  const root = mkdtempSync(join(tmpdir(), "pi-esbuild-optional-"));
  try {
    // 1.4.0 之后 @earendil-works/chord 离开，standalone 里不再 trace 出 esbuild。
    assert.equal(readOptionalEsbuildManifest(join(root, "esbuild")), null);

    const present = join(root, "present");
    mkdirSync(present, { recursive: true });
    writeFileSync(join(present, "package.json"), JSON.stringify({ version: "0.28.2" }));
    assert.deepEqual(readOptionalEsbuildManifest(present), { version: "0.28.2" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
