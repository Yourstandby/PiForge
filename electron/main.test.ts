import test from "node:test";
import assert from "node:assert/strict";
import { childProcessEnv } from "./env-filter.ts";

test("childProcessEnv keeps OS-critical vars (SystemRoot was the ws-bus killer)", () => {
  const env = {
    PATH: "/usr/bin",
    SystemRoot: "C:\Windows",
    windir: "C:\Windows",
    ComSpec: "C:\Windows\system32\cmd.exe",
    APPDATA: "C:\Users\me\AppData\Roaming",
  };

  assert.deepEqual(childProcessEnv(env), env);
});

test("childProcessEnv keeps provider API keys (DeepSeek etc.) and proxy settings", () => {
  const env = {
    DEEPSEEK_API_KEY: "sk-deepseek",
    XAI_API_KEY: "xai",
    HTTPS_PROXY: "http://127.0.0.1:7890",
    SECRET_TOKEN: "secret",
  };

  assert.deepEqual(childProcessEnv(env), {
    DEEPSEEK_API_KEY: "sk-deepseek",
    XAI_API_KEY: "xai",
    HTTPS_PROXY: "http://127.0.0.1:7890",
    SECRET_TOKEN: "secret",
  });
});

test("childProcessEnv drops Electron-as-Node and stale host control vars", () => {
  const env = {
    ELECTRON_RUN_AS_NODE: "1",
    ELECTRON_RUN_AS_NODE_ENABLED: "1",
    PIFORGE_AGENT_ENDPOINT: "\\.\pipe\stale",
    PIFORGE_AGENT_TOKEN: "stale",
    PATH: "/usr/bin",
  };

  assert.deepEqual(childProcessEnv(env), { PATH: "/usr/bin" });
});

test("childProcessEnv skips undefined values", () => {
  assert.deepEqual(childProcessEnv({ PATH: "/usr/bin", NOPE: undefined }), {
    PATH: "/usr/bin",
  });
});

test("childProcessEnv returns empty object for empty env", () => {
  assert.deepEqual(childProcessEnv({}), {});
});
