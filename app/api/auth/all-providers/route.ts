import { createPiRuntime } from "../../../../lib/pi-runtime.ts";
import { activeProviderEnvVar, listProviderEnvVars } from "../../../../lib/provider-env-vars.ts";

export const dynamic = "force-dynamic";

// Providers that use OAuth — handled separately via /api/auth/providers
const OAUTH_PROVIDER_IDS = new Set(["anthropic", "github-copilot", "openai-codex"]);

export async function GET() {
  const { runtime, registry } = await createPiRuntime();
  const all = registry.getAll();
  // Use runtime.getProviders() as source of truth so providers without a
  // registry entry (e.g. image-only or zero-model edge) are not invisible.
  const providers = runtime.getProviders();

  const result: {
    id: string;
    displayName: string;
    configured: boolean;
    source?: string;
    modelCount: number;
    /** Env vars that can supply this provider's API key (set or not). */
    envVars: string[];
    /** The env var currently set in this process, if any. */
    envVarSet?: string;
  }[] = [];

  for (const p of providers) {
    if (OAUTH_PROVIDER_IDS.has(p.id)) continue;
    const status = runtime.getProviderAuthStatus(p.id);
    // Skip custom providers whose key is injected via models.json
    if (status.source === "models_json_key") continue;
    const displayName = registry.getProviderDisplayName(p.id);
    const modelCount = all.filter((x) => x.provider === p.id).length;
    result.push({
      id: p.id,
      displayName,
      configured: status.configured,
      source: status.source,
      modelCount,
      envVars: listProviderEnvVars(p.id),
      envVarSet: activeProviderEnvVar(p.id),
    });
  }

  return Response.json({ providers: result });
}
