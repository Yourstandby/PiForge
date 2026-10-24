import assert from "node:assert/strict";
import { posix, win32 } from "node:path";
import test from "node:test";
import { DEFAULT_TARGETS, defaultTarget, resourcesDirFor } from "./smoke-target.mjs";

test("each platform resolves to its electron-builder output layout", () => {
  assert.equal(defaultTarget("win32"), "release/win-unpacked/PiForge.exe");
  assert.equal(defaultTarget("linux"), "release/linux-unpacked/piforge");
  assert.equal(
    defaultTarget("darwin"),
    "release/mac-universal/PiForge.app/Contents/MacOS/PiForge",
    "macOS 的可执行文件在 .app 包里，不是 linux-unpacked/piforge",
  );
  // 未知平台回落 linux（CI 里跑的 ubuntu runner 是常态，宁可指向 linux 布局）
  assert.equal(defaultTarget("freebsd"), DEFAULT_TARGETS.linux);
});

test("resources dir follows the macOS bundle layout", () => {
  const exe = "/repo/release/mac-universal/PiForge.app/Contents/MacOS/PiForge";
  assert.equal(
    resourcesDirFor(exe, posix),
    "/repo/release/mac-universal/PiForge.app/Contents/Resources",
    "macOS 的 resources 在 Contents/Resources，不在 exe 同级的 resources/",
  );
});

test("windows and linux keep resources next to the executable", () => {
  assert.equal(
    resourcesDirFor("D:\\repo\\release\\win-unpacked\\PiForge.exe", win32),
    "D:\\repo\\release\\win-unpacked\\resources",
  );
  assert.equal(
    resourcesDirFor("/repo/release/linux-unpacked/piforge", posix),
    "/repo/release/linux-unpacked/resources",
  );
});
