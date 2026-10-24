import assert from "node:assert/strict";
import test from "node:test";
import {
  THEME_STORAGE_KEY,
  applyTheme,
  readStoredTheme,
  resolveTheme,
  saveThemePreference,
  watchSystemTheme,
} from "./theme.ts";

function installBrowser(options: { stored?: string | null; systemDark?: boolean } = {}) {
  const dataset: Record<string, string> = {};
  const style: Record<string, string> = {};
  const listeners: Array<(event: { matches: boolean }) => void> = [];
  const storage = new Map<string, string>();
  if (options.stored != null) storage.set(THEME_STORAGE_KEY, options.stored);

  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = { window: globals.window, document: globals.document };
  globals.document = { documentElement: { dataset, style } };
  globals.window = {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
    },
    matchMedia: (query: string) => ({
      matches: Boolean(options.systemDark),
      media: query,
      addEventListener: (_: string, listener: (event: { matches: boolean }) => void) =>
        void listeners.push(listener),
      removeEventListener: (_: string, listener: (event: { matches: boolean }) => void) => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      },
    }),
  };

  return {
    dataset,
    style,
    listeners,
    storage,
    restore() {
      globals.window = previous.window;
      globals.document = previous.document;
    },
  };
}

test("readStoredTheme 只接受三个合法值，其余回落到跟随系统", () => {
  let env = installBrowser({ stored: "dark" });
  assert.equal(readStoredTheme(), "dark");
  env.restore();

  env = installBrowser({ stored: "neon" });
  assert.equal(readStoredTheme(), "system");
  env.restore();

  env = installBrowser();
  assert.equal(readStoredTheme(), "system");
  env.restore();
});

test("resolveTheme：system 跟随系统，显式偏好优先", () => {
  let env = installBrowser({ systemDark: true });
  assert.equal(resolveTheme("system"), "dark");
  assert.equal(resolveTheme("light"), "light");
  env.restore();

  env = installBrowser({ systemDark: false });
  assert.equal(resolveTheme("system"), "light");
  assert.equal(resolveTheme("dark"), "dark");
  env.restore();
});

test("applyTheme 把结果写到 <html data-theme> 与 color-scheme", () => {
  const env = installBrowser({ systemDark: true });
  assert.equal(applyTheme("system"), "dark");
  assert.equal(env.dataset.theme, "dark");
  assert.equal(env.style.colorScheme, "dark");

  assert.equal(applyTheme("light"), "light");
  assert.equal(env.dataset.theme, "light");
  assert.equal(env.style.colorScheme, "light");
  env.restore();
});

test("saveThemePreference 持久化到 pi-theme", () => {
  const env = installBrowser();
  saveThemePreference("dark");
  assert.equal(env.storage.get(THEME_STORAGE_KEY), "dark");
  env.restore();
});

test("watchSystemTheme 只在跟随系统时订阅，并回报解析结果", () => {
  const env = installBrowser({ systemDark: false });
  const seen: string[] = [];
  const stopSystem = watchSystemTheme("system", (value) => seen.push(value));
  assert.equal(env.listeners.length, 1);
  env.listeners[0]!({ matches: true });
  assert.deepEqual(seen, ["dark"]);
  stopSystem();
  assert.equal(env.listeners.length, 0);

  const stopFixed = watchSystemTheme("light", (value) => seen.push(value));
  assert.equal(env.listeners.length, 0);
  stopFixed();
  env.restore();
});
