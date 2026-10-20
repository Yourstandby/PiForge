import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CustomProviderError,
  listCustomProviders,
  removeCustomProvider,
  saveCustomProvider,
  syncCustomProvidersToModels,
} from "./custom-providers.ts";

function tempAgentDir(): string {
  return mkdtempSync(join(tmpdir(), "piforge-providers-"));
}

test("saveCustomProvider materializes models.json and masks the key", () => {
  const dir = tempAgentDir();
  try {
    const view = saveCustomProvider({
      id: "ollama-local",
      name: "Local Ollama",
      baseUrl: "http://127.0.0.1:11434/v1/",
      api: "openai-completions",
      apiKey: "ollama-secret-1234",
      models: [{ id: "qwen2.5-coder:7b", name: "Qwen Coder" }],
    }, dir);
    assert.equal(view.id, "ollama-local");
    assert.equal(view.baseUrl, "http://127.0.0.1:11434/v1");
    assert.equal(view.hasApiKey, true);
    assert.match(view.apiKeyHint, /1234$/);
    assert.doesNotMatch(JSON.stringify(view), /secret-1234/);

    const models = JSON.parse(readFileSync(join(dir, "models.json"), "utf8")) as {
      providers: Record<string, { baseUrl: string; apiKey: string; models: { id: string }[] }>;
    };
    assert.equal(models.providers["ollama-local"].baseUrl, "http://127.0.0.1:11434/v1");
    assert.equal(models.providers["ollama-local"].apiKey, "ollama-secret-1234");
    assert.equal(models.providers["ollama-local"].models[0].id, "qwen2.5-coder:7b");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saving without apiKey preserves the stored secret; empty clears it", () => {
  const dir = tempAgentDir();
  try {
    saveCustomProvider({ id: "gw", baseUrl: "https://gw.example.com/v1", apiKey: "keep-me", models: [] }, dir);
    const preserved = saveCustomProvider({ id: "gw", baseUrl: "https://gw.example.com/v1", models: [] }, dir);
    assert.equal(preserved.hasApiKey, true);
    const cleared = saveCustomProvider({ id: "gw", baseUrl: "https://gw.example.com/v1", apiKey: " ", models: [] }, dir);
    assert.equal(cleared.hasApiKey, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listCustomProviders hides secrets and remove drops the models entry", () => {
  const dir = tempAgentDir();
  try {
    saveCustomProvider({ id: "one", baseUrl: "http://localhost:8000/v1", apiKey: "abcdef", models: [{ id: "m1" }] }, dir);
    const listed = listCustomProviders(dir);
    assert.equal(listed.length, 1);
    assert.match(listed[0].apiKeyHint, /^••••cdef$/);
    removeCustomProvider("one", dir);
    assert.equal(listCustomProviders(dir).length, 0);
    const models = JSON.parse(readFileSync(join(dir, "models.json"), "utf8")) as { providers: Record<string, unknown> };
    assert.equal(models.providers.one, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("syncCustomProvidersToModels preserves unrelated providers", () => {
  const dir = tempAgentDir();
  try {
    saveCustomProvider({ id: "custom-a", baseUrl: "http://localhost:1234/v1", models: [{ id: "a" }] }, dir);
    const modelsPath = join(dir, "models.json");
    const current = JSON.parse(readFileSync(modelsPath, "utf8")) as Record<string, unknown>;
    current.providers = { ...(current.providers as object), builtin: { baseUrl: "https://example.com" } };
    writeFileSync(modelsPath, JSON.stringify(current));
    syncCustomProvidersToModels(dir);
    const synced = JSON.parse(readFileSync(modelsPath, "utf8")) as { providers: Record<string, unknown> };
    assert.ok(synced.providers.builtin);
    assert.ok(synced.providers["custom-a"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid provider input is rejected", () => {
  assert.throws(
    () => saveCustomProvider({ id: "Bad ID", baseUrl: "ftp://x", models: [] }, tempAgentDir()),
    (error: unknown) => error instanceof CustomProviderError,
  );
  assert.throws(
    () => saveCustomProvider({ id: "ok", baseUrl: "ftp://x", models: [] }, tempAgentDir()),
    (error: unknown) => error instanceof CustomProviderError && /http/.test(error.message),
  );
  assert.throws(
    () => saveCustomProvider({ id: "ok", baseUrl: "https://x", models: [{ id: "a" }, { id: "a" }] }, tempAgentDir()),
    (error: unknown) => error instanceof CustomProviderError && /duplicate/.test(error.message),
  );
});
