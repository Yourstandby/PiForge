import test from "node:test";
import assert from "node:assert/strict";
import { getAllUpstreamUsage, getUpstreamProviderUsage } from "./service.ts";

const deepSeekBalance = () =>
  new Response(
    JSON.stringify({
      is_available: true,
      balance_infos: [
        {
          currency: "CNY",
          total_balance: "52.32",
          granted_balance: "0.00",
          topped_up_balance: "52.32",
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );

test("queries balance when auth.json has no entry but the runtime supplies a key", async () => {
  const seen: string[] = [];
  const usage = await getUpstreamProviderUsage("deepseek", {
    // Empty map mimics an auth.json that was cleared while the key lives in
    // DEEPSEEK_API_KEY; the runtime lookup is what recovers it.
    auth: {},
    resolveAuth: async (providerId) => {
      seen.push(providerId);
      return { apiKey: "sk-test" };
    },
    fetchImpl: (async () => deepSeekBalance()) as unknown as typeof fetch,
  });

  assert.deepEqual(seen, ["deepseek"]);
  assert.equal(usage?.error, undefined);
  assert.equal(usage?.provider, "deepseek");
  assert.equal(usage?.balance?.[0]?.total, "52.32");
});

test("drops a provider when no credential exists anywhere", async () => {
  let fetched = 0;
  const usage = await getUpstreamProviderUsage("openrouter", {
    auth: {},
    resolveAuth: async () => ({}),
    fetchImpl: (async () => {
      fetched += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch,
  });

  assert.equal(usage, null);
  assert.equal(fetched, 0, "no upstream request without a credential");
});

test("getAllUpstreamUsage probes providers missing from auth.json", async () => {
  const requested: string[] = [];
  const usages = await getAllUpstreamUsage({
    auth: {},
    now: Date.now() + 10 * 60 * 1000, // bypass the 120s cache of the first test
    resolveAuth: async (providerId) => (providerId === "deepseek" ? { apiKey: "sk-test" } : {}),
    fetchImpl: (async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return deepSeekBalance();
    }) as unknown as typeof fetch,
  });

  assert.equal(usages.length, 1);
  assert.equal(usages[0].provider, "deepseek");
  assert.deepEqual(requested, ["https://api.deepseek.com/user/balance"]);
});
