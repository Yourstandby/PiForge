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

test("GET /api/watchdog proxies the read-only watchdog.status snapshot", async () => {
  const snapshot = {
    enabled: true,
    config: { tickMs: 10_000, stallMs: 20_000, stallScans: 3, backoffMs: [30_000, 60_000, 120_000] },
    tasks: [],
    notices: [],
  };
  const stub = stubClient(() => snapshot);
  try {
    const res = await GET(new Request("http://localhost/api/watchdog"));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(await res.json(), snapshot);
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0]?.method, "watchdog.status");
    assert.deepEqual(stub.calls[0]?.params, {});
  } finally {
    stub.restore();
  }
});

test("GET /api/watchdog surfaces a disabled switch without inventing data", async () => {
  const stub = stubClient(() => ({ enabled: false, config: null, tasks: [], notices: [] }));
  try {
    const res = await GET(new Request("http://localhost/api/watchdog"));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { enabled: false, config: null, tasks: [], notices: [] });
  } finally {
    stub.restore();
  }
});

test("POST /api/watchdog forwards watchdog.configure and returns the new config view", async () => {
  const config = { tickMs: 10_000, stallMs: 30_000, stallScans: 3, backoffMs: [30_000, 60_000, 120_000] };
  const stub = stubClient(() => config);
  try {
    const res = await POST(
      new Request("http://localhost/api/watchdog", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stallMs: 30_000 }),
      }),
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(await res.json(), config);
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0]?.method, "watchdog.configure");
    assert.deepEqual(stub.calls[0]?.params, { stallMs: 30_000 });
  } finally {
    stub.restore();
  }
});

test("POST /api/watchdog rejects a non-numeric stallMs without touching the Host", async () => {
  const stub = stubClient(() => ({ ok: true }));
  try {
    const res = await POST(
      new Request("http://localhost/api/watchdog", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stallMs: "30s" }),
      }),
    );
    assert.equal(res.status, 400);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});
