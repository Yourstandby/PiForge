import assert from "node:assert/strict";
import test from "node:test";
import {
  applyTitleBarOverlayTheme,
  normalizeTitleBarTheme,
} from "./title-bar-overlay.ts";

test("applyTitleBarOverlayTheme ignores runtimes without overlay support", () => {
  assert.equal(applyTitleBarOverlayTheme(null, "dark"), false);
  assert.equal(applyTitleBarOverlayTheme({}, "light"), false);
});

test("applyTitleBarOverlayTheme applies light, dark and glacier window colors", () => {
  const calls: Array<{ color: string; symbolColor: string }> = [];
  const target = {
    setTitleBarOverlay(options: { color: string; symbolColor: string }) {
      calls.push(options);
    },
  };

  assert.equal(applyTitleBarOverlayTheme(target, "light"), true);
  assert.equal(applyTitleBarOverlayTheme(target, "dark"), true);
  assert.equal(applyTitleBarOverlayTheme(target, "glacier"), true);
  assert.deepEqual(calls, [
    { color: "#ffffff", symbolColor: "#364152" },
    { color: "#0c1118", symbolColor: "#d9deea" },
    { color: "#070d18", symbolColor: "#c9d9ee" },
  ]);
});

test("normalizeTitleBarTheme falls back to light for unknown values", () => {
  assert.equal(normalizeTitleBarTheme("glacier"), "glacier");
  assert.equal(normalizeTitleBarTheme("dark"), "dark");
  assert.equal(normalizeTitleBarTheme("light"), "light");
  assert.equal(normalizeTitleBarTheme(undefined), "light");
  assert.equal(normalizeTitleBarTheme("midnight"), "light");
});
