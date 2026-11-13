import { findEnvKeys } from "@earendil-works/pi-ai/compat";

/**
 * pi-ai can only tell us which env vars are *currently set*; the full list of
 * accepted names is internal. Probe it with an env object that answers every
 * lookup so `findEnvKeys` reports the provider's supported variable names.
 */
function anyEnvValue(): Record<string, string> {
  return new Proxy({} as Record<string, string>, {
    get: (_target, key) => (typeof key === "string" ? "1" : undefined),
  });
}

/** API-key env var names this provider accepts, whether or not they are set. */
export function listProviderEnvVars(providerId: string): string[] {
  return findEnvKeys(providerId, anyEnvValue()) ?? [];
}

/** The env var that is actually set right now (pi priority order), if any. */
export function activeProviderEnvVar(providerId: string): string | undefined {
  return findEnvKeys(providerId)?.[0];
}
