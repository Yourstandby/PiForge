import assert from "node:assert/strict";
import test from "node:test";
import { nextTheme, normalizeTheme, themeClasses, THEMES } from "./theme.ts";

test("themeClasses keeps glacier inside the dark family", () => {
  assert.deepEqual(themeClasses("light"), { dark: false, glacier: false });
  assert.deepEqual(themeClasses("dark"), { dark: true, glacier: false });
  assert.deepEqual(themeClasses("glacier"), { dark: true, glacier: true });
});

test("normalizeTheme only accepts known theme names", () => {
  for (const theme of THEMES) {
    assert.equal(normalizeTheme(theme), theme);
  }
  assert.equal(normalizeTheme("midnight"), "light");
  assert.equal(normalizeTheme(null), "light");
  assert.equal(normalizeTheme(undefined), "light");
});

test("nextTheme cycles light → dark → glacier → light", () => {
  assert.equal(nextTheme("light"), "dark");
  assert.equal(nextTheme("dark"), "glacier");
  assert.equal(nextTheme("glacier"), "light");
});
