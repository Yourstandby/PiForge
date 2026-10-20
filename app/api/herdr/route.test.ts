import test from "node:test";
import assert from "node:assert/strict";
import { GET, POST } from "./route.ts";

function stubClient(handler: (method: string, params: Record<string, unknown>) => unknown) {
  const previous = globalThis.__piforgeAgentHostClient;
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  globalThis.__piforgeAgentHostClient = {
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return handler(method, params);
    },
  } as unknown as typeof previous;
  return { calls, restore: () => { globalThis.__piforgeAgentHostClient = previous; } };
}

test("GET /api/herdr proxies herdr.list", async () => {
  const stub = stubClient(() => ({ agents: [{ id: "herdr-1", name: "scout" }] }));
  try {
    const res = await GET(new Request("http://localhost/api/herdr"));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { agents: [{ id: "herdr-1", name: "scout" }] });
    assert.equal(stub.calls[0]?.method, "herdr.list");
  } finally {
    stub.restore();
  }
});

test("POST /api/herdr validates stop requests", async () => {
  const stub = stubClient(() => ({ ok: true }));
  try {
    const bad = await POST(
      new Request("http://localhost/api/herdr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop" }),
      }),
    );
    assert.equal(bad.status, 400);

    const good = await POST(
      new Request("http://localhost/api/herdr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop", id: "herdr-1" }),
      }),
    );
    assert.equal(good.status, 200);
    assert.equal(stub.calls[0]?.method, "herdr.stop");
    assert.equal(stub.calls[0]?.params.id, "herdr-1");
  } finally {
    stub.restore();
  }
});
