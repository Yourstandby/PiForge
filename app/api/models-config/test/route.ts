import { NextResponse } from "../../../../lib/next-server-shim.ts";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { completeSimple, getEnvApiKey, type AssistantMessage } from "@earendil-works/pi-ai/compat";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createPiRuntime } from "../../../../lib/pi-runtime.ts";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { isObject } from "../../../../lib/normalize.ts";
import { errorMessage, getRequestId, logApiError } from "../../../../lib/api-error.ts";
import { listProviderEnvVars } from "../../../../lib/provider-env-vars.ts";

export const dynamic = "force-dynamic";

const TEST_TIMEOUT_MS = 20_000;
/** Provider-level probes may try a few models; stop early instead of stacking timeouts. */
const PROVIDER_TEST_BUDGET_MS = 30_000;
const MAX_PROVIDER_PROBES = 3;

function getAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

type ProbeResult =
  | { ok: true; latencyMs: number; status?: number; responseText?: string }
  | { ok: false; error: string; latencyMs?: number; status?: number };

/**
 * One throwaway completion against a single model; never throws.
 * `apiKeyOverride` forces a specific credential (the env-var probe) instead of
 * whatever auth.json/environment resolution would pick.
 */
async function probeModel(registry: ModelRegistry, model: Model<Api>, apiKeyOverride?: string): Promise<ProbeResult> {
  const auth = await registry.getApiKeyAndHeaders(model);
  const headers = auth.ok ? auth.headers : undefined;
  const apiKey = apiKeyOverride ?? (auth.ok ? auth.apiKey : undefined);
  if (!apiKey) return { ok: false, error: auth.ok ? `No API key found for "${model.provider}"` : auth.error };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  let status: number | undefined;
  const startedAt = Date.now();

  try {
    const message = await completeSimple(model, {
      messages: [{
        role: "user",
        content: "Reply with OK only.",
        timestamp: Date.now(),
      }],
    }, {
      apiKey,
      headers,
      maxTokens: 16,
      timeoutMs: TEST_TIMEOUT_MS,
      maxRetries: 0,
      cacheRetention: "none",
      signal: controller.signal,
      onResponse: (response) => { status = response.status; },
    });

    const latencyMs = Date.now() - startedAt;
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      return {
        ok: false,
        error: message.errorMessage ?? (controller.signal.aborted ? "Test timed out" : "Model returned an error"),
        latencyMs,
        status,
      };
    }

    return { ok: true, latencyMs, status, responseText: getAssistantText(message).slice(0, 300) };
  } catch (error) {
    return { ok: false, error: errorMessage(error), latencyMs: Date.now() - startedAt, status };
  } finally {
    clearTimeout(timeout);
  }
}

export async function POST(req: Request) {
  const requestId = getRequestId(req);
  let tempDir: string | undefined;

  try {
    const body = await req.json() as { providerName?: unknown; provider?: unknown; model?: unknown; authSource?: unknown };
    const providerName = typeof body.providerName === "string" ? body.providerName.trim() : "";
    if (!providerName) return NextResponse.json({ ok: false, error: "providerName is required" }, { status: 400, headers: { "x-request-id": requestId } });

    const useEnvAuth = body.authSource === "env";
    const hasProvider = isObject(body.provider);
    const hasModel = isObject(body.model);
    if (hasProvider !== hasModel) {
      return NextResponse.json(
        { ok: false, error: "provider and model must be provided together" },
        { status: 400, headers: { "x-request-id": requestId } }
      );
    }

    // With a provider draft we test exactly that unsaved config from a scratch
    // models.json. Without one we are testing an already-saved provider (the
    // API-key panel), so read the live models.json.
    let draftModelId = "";
    if (hasProvider) {
      draftModelId = typeof (body.model as { id?: unknown }).id === "string"
        ? ((body.model as { id: string }).id).trim()
        : "";
      if (!draftModelId) return NextResponse.json({ ok: false, error: "Model ID is required" }, { status: 400, headers: { "x-request-id": requestId } });

      tempDir = mkdtempSync(join(tmpdir(), "pi-web-model-test-"));
      writeFileSync(join(tempDir, "models.json"), JSON.stringify({
        providers: {
          [providerName]: {
            ...(body.provider as Record<string, unknown>),
            models: [{ ...(body.model as Record<string, unknown>), id: draftModelId }],
          },
        },
      }, null, 2), "utf8");
    }

    const { registry } = tempDir
      ? await createPiRuntime({ modelsPath: join(tempDir, "models.json"), allowModelNetwork: false })
      : await createPiRuntime({ allowModelNetwork: false });
    const loadError = registry.getError();
    if (loadError) return NextResponse.json({ ok: false, error: loadError });

    let candidates: Model<Api>[];
    if (hasProvider) {
      const model = registry.find(providerName, draftModelId);
      if (!model) return NextResponse.json({ ok: false, error: `Model not found: ${providerName}/${draftModelId}` });
      candidates = [model];
    } else {
      // Prefer the cheapest non-reasoning model: fastest and least likely to
      // burn quota on a probe, and reasoning models often reject maxTokens=16.
      candidates = registry.getAll()
        .filter((m) => m.provider === providerName)
        .sort((a, b) => {
          const reasoningDelta = Number(a.reasoning === true) - Number(b.reasoning === true);
          if (reasoningDelta !== 0) return reasoningDelta;
          return (a.cost?.input ?? 0) - (b.cost?.input ?? 0);
        })
        .slice(0, MAX_PROVIDER_PROBES);
      if (candidates.length === 0) {
        return NextResponse.json({ ok: false, error: `No models configured for "${providerName}"` });
      }
    }

    // "Test with environment variable": resolve the key from env only, so a
    // stored auth.json key cannot mask a broken/missing env setup.
    let envApiKey: string | undefined;
    if (useEnvAuth) {
      envApiKey = getEnvApiKey(providerName);
      if (!envApiKey) {
        const names = listProviderEnvVars(providerName);
        return NextResponse.json({
          ok: false,
          error: names.length
            ? `Environment variable not set: ${names.join(" / ")}`
            : `"${providerName}" has no known API-key environment variable`,
        });
      }
    }

    const startedAt = Date.now();
    let last: (ProbeResult & { ok: false }) | undefined;
    for (const [index, model] of candidates.entries()) {
      if (index > 0 && Date.now() - startedAt > PROVIDER_TEST_BUDGET_MS) break;
      const result = await probeModel(registry, model, envApiKey);
      if (result.ok) {
        return NextResponse.json({
          ...result,
          provider: providerName,
          model: model.id,
          attempts: index + 1,
        });
      }
      last = result;
    }

    return NextResponse.json({
      ...last,
      provider: providerName,
      model: candidates[candidates.length - 1]?.id,
      attempts: candidates.length,
    });
  } catch (error) {
    logApiError({ route: "/api/models-config/test", method: "POST", requestId, error });
    return NextResponse.json(
      { ok: false, error: errorMessage(error) },
      { status: 500, headers: { "x-request-id": requestId } }
    );
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
}
