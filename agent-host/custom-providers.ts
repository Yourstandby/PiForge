/**
 * Host-owned custom provider registry (v0.7.0 module 1).
 *
 * Source of truth: `<agentDir>/custom-providers.json` (contains the API key).
 * On every mutation the Host also materializes the entries into
 * `<agentDir>/models.json`, which is what Pi's ModelRuntime reads.
 *
 * Next/Renderer never read this file; they call the Host RPC methods and only
 * receive masked views.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writeFileAtomic } from "../lib/atomic-write.ts";
import type {
  CustomProviderInput,
  CustomProviderModel,
  CustomProviderView,
} from "../contract/domains/providers.ts";

const PROVIDERS_FILENAME = "custom-providers.json";
const PROVIDER_ID_RE = /^[a-z][a-z0-9-]{1,63}$/;
const API_RE = /^[a-z][a-z0-9-]{1,63}$/;

interface StoredProvider {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  apiKey?: string;
  models: CustomProviderModel[];
  updatedAt: number;
}

interface StoredFile {
  version: 1;
  providers: Record<string, StoredProvider>;
}

export class CustomProviderError extends Error {
  readonly code: "E_INVALID_PARAMS" | "E_PROVIDER_EXISTS" | "E_IO";

  constructor(code: CustomProviderError["code"], message: string) {
    super(message);
    this.name = "CustomProviderError";
    this.code = code;
  }
}

function pathFor(agentDir: string): string {
  return join(agentDir, PROVIDERS_FILENAME);
}

function modelsPathFor(agentDir: string): string {
  return join(agentDir, "models.json");
}

function readStored(agentDir: string): StoredFile {
  const file = pathFor(agentDir);
  if (!existsSync(file)) return { version: 1, providers: {} };
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("custom-providers.json must be an object");
    }
    const providersRaw = (raw as { providers?: unknown }).providers;
    const providers: Record<string, StoredProvider> = {};
    if (providersRaw && typeof providersRaw === "object" && !Array.isArray(providersRaw)) {
      for (const [id, value] of Object.entries(providersRaw as Record<string, unknown>)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const entry = value as Record<string, unknown>;
        if (typeof entry.baseUrl !== "string" || typeof entry.api !== "string") continue;
        const models = Array.isArray(entry.models)
          ? entry.models
              .filter((m): m is Record<string, unknown> => Boolean(m) && typeof m === "object")
              .filter((m) => typeof m.id === "string" && m.id.trim().length > 0)
              .map((m) => ({
                id: m.id as string,
                ...(typeof m.name === "string" && m.name.trim() ? { name: m.name } : {}),
              }))
          : [];
        providers[id] = {
          id,
          name: typeof entry.name === "string" && entry.name.trim() ? entry.name : id,
          baseUrl: entry.baseUrl,
          api: entry.api,
          ...(typeof entry.apiKey === "string" && entry.apiKey ? { apiKey: entry.apiKey } : {}),
          models,
          updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : Date.now(),
        };
      }
    }
    return { version: 1, providers };
  } catch (error) {
    throw new CustomProviderError(
      "E_IO",
      `Cannot read ${PROVIDERS_FILENAME}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function writeStored(agentDir: string, file: StoredFile): void {
  const target = pathFor(agentDir);
  mkdirSync(dirname(target), { recursive: true });
  writeFileAtomic(target, `${JSON.stringify(file, null, 2)}\n`);
}

function maskKey(key: string | undefined): { hasApiKey: boolean; apiKeyHint: string } {
  if (!key) return { hasApiKey: false, apiKeyHint: "" };
  return { hasApiKey: true, apiKeyHint: `••••${key.slice(-4)}` };
}

export function toProviderView(provider: StoredProvider): CustomProviderView {
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    api: provider.api,
    ...maskKey(provider.apiKey),
    models: provider.models.map((model) => ({
      id: model.id,
      ...(model.name ? { name: model.name } : {}),
    })),
    updatedAt: provider.updatedAt,
  };
}

export function listCustomProviders(agentDir = getAgentDir()): CustomProviderView[] {
  return Object.values(readStored(agentDir).providers)
    .map(toProviderView)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function validateBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CustomProviderError("E_INVALID_PARAMS", "baseUrl must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CustomProviderError("E_INVALID_PARAMS", "baseUrl must use http or https");
  }
  if (url.username || url.password) {
    throw new CustomProviderError("E_INVALID_PARAMS", "baseUrl must not embed credentials");
  }
  return value.replace(/\/+$/, "");
}

export function validateCustomProviderInput(input: CustomProviderInput): void {
  if (!PROVIDER_ID_RE.test(input.id)) {
    throw new CustomProviderError(
      "E_INVALID_PARAMS",
      "id must be 2-64 lowercase letters/digits/hyphens and start with a letter",
    );
  }
  if (typeof input.baseUrl !== "string") {
    throw new CustomProviderError("E_INVALID_PARAMS", "baseUrl is required");
  }
  validateBaseUrl(input.baseUrl);
  if (input.api !== undefined && !API_RE.test(input.api)) {
    throw new CustomProviderError("E_INVALID_PARAMS", "api must be a lowercase identifier");
  }
  if (input.apiKey !== undefined && typeof input.apiKey !== "string") {
    throw new CustomProviderError("E_INVALID_PARAMS", "apiKey must be a string");
  }
  if (!Array.isArray(input.models)) {
    throw new CustomProviderError("E_INVALID_PARAMS", "models must be an array");
  }
  const seen = new Set<string>();
  for (const model of input.models) {
    if (!model || typeof model.id !== "string" || !model.id.trim()) {
      throw new CustomProviderError("E_INVALID_PARAMS", "every model needs a non-empty id");
    }
    if (seen.has(model.id)) {
      throw new CustomProviderError("E_INVALID_PARAMS", `duplicate model id: ${model.id}`);
    }
    seen.add(model.id);
  }
}

function readModelsJson(agentDir: string): Record<string, unknown> {
  const file = modelsPathFor(agentDir);
  if (!existsSync(file)) return { providers: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through: a corrupt models.json is replaced by a minimal valid one
    // rather than making provider management impossible.
  }
  return { providers: {} };
}

/** Materialize all managed providers into models.json, preserving other entries. */
export function syncCustomProvidersToModels(agentDir = getAgentDir()): void {
  const stored = readStored(agentDir);
  const modelsJson = readModelsJson(agentDir);
  const providersRaw = modelsJson.providers;
  const providers =
    providersRaw && typeof providersRaw === "object" && !Array.isArray(providersRaw)
      ? { ...(providersRaw as Record<string, unknown>) }
      : {};

  for (const provider of Object.values(stored.providers)) {
    providers[provider.id] = {
      baseUrl: provider.baseUrl,
      api: provider.api,
      ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
      models: provider.models.map((model) => ({
        id: model.id,
        name: model.name?.trim() || model.id,
      })),
    };
  }
  modelsJson.providers = providers;
  const target = modelsPathFor(agentDir);
  mkdirSync(dirname(target), { recursive: true });
  writeFileAtomic(target, `${JSON.stringify(modelsJson, null, 2)}\n`);
}

export function saveCustomProvider(
  input: CustomProviderInput,
  agentDir = getAgentDir(),
): CustomProviderView {
  validateCustomProviderInput(input);
  const stored = readStored(agentDir);
  const previous = stored.providers[input.id];
  const apiKey =
    input.apiKey === undefined
      ? previous?.apiKey
      : input.apiKey.trim()
        ? input.apiKey.trim()
        : undefined;
  const provider: StoredProvider = {
    id: input.id,
    name: input.name?.trim() || input.id,
    baseUrl: validateBaseUrl(input.baseUrl),
    api: input.api ?? "openai-completions",
    ...(apiKey ? { apiKey } : {}),
    models: input.models.map((model) => ({
      id: model.id.trim(),
      ...(model.name?.trim() ? { name: model.name.trim() } : {}),
    })),
    updatedAt: Date.now(),
  };
  stored.providers[provider.id] = provider;
  writeStored(agentDir, stored);
  syncCustomProvidersToModels(agentDir);
  return toProviderView(provider);
}

export function removeCustomProvider(id: string, agentDir = getAgentDir()): void {
  if (!PROVIDER_ID_RE.test(id)) {
    throw new CustomProviderError("E_INVALID_PARAMS", "invalid provider id");
  }
  const stored = readStored(agentDir);
  if (!stored.providers[id]) {
    throw new CustomProviderError("E_INVALID_PARAMS", `unknown custom provider: ${id}`);
  }
  delete stored.providers[id];
  writeStored(agentDir, stored);

  const modelsJson = readModelsJson(agentDir);
  const providersRaw = modelsJson.providers;
  if (providersRaw && typeof providersRaw === "object" && !Array.isArray(providersRaw)) {
    const providers = { ...(providersRaw as Record<string, unknown>) };
    delete providers[id];
    modelsJson.providers = providers;
    writeFileAtomic(modelsPathFor(agentDir), `${JSON.stringify(modelsJson, null, 2)}\n`);
  }
}

/** Test helper: write a file directly without validation. */
export function writeProviderStateForTest(agentDir: string, raw: unknown): void {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(pathFor(agentDir), JSON.stringify(raw, null, 2), "utf8");
}
