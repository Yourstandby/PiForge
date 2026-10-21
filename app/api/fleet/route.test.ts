import test from "node:test";
import assert from "node:assert/strict";
import { GET, POST } from "./route.ts";

type StubCall = { method: string; params: Record<string, unknown> };

function stubClient(handler: (method: string, params: Record<string, unknown>) => unknown) {
  const previous = globalThis.__piforgeAgentHostClient;
  const calls: StubCall[] = [];
  globalThis.__piforgeAgentHostClient = {
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return handler(method, params);
    },
  } as unknown as typeof previous;
  return {
    calls,
    restore: () => {
      globalThis.__piforgeAgentHostClient = previous;
    },
  };
}

const profile = {
  id: "fleet-auditor",
  name: "auditor",
  systemPrompt: "只读审计",
  tools: ["read", "grep"],
  persistent: true,
  createdAt: 1,
  updatedAt: 2,
};

test("GET /api/fleet returns profiles and live agents", async () => {
  const stub = stubClient((method) => {
    assert.equal(method, "fleet.list");
    return { profiles: [profile], agents: [] };
  });
  try {
    const res = await GET(new Request("http://localhost/api/fleet"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { profiles: unknown[]; agents: unknown[] };
    assert.equal(body.profiles.length, 1);
    assert.equal(body.agents.length, 0);
    assert.equal(stub.calls[0].method, "fleet.list");
  } finally {
    stub.restore();
  }
});

test("POST /api/fleet save / wake / message map to host methods", async () => {
  const stub = stubClient((method, params) => {
    if (method === "fleet.save") return { profile: { ...profile, id: "fleet-new" } };
    if (method === "fleet.wake") return { agent: { id: "herdr-1", name: params.id } };
    if (method === "fleet.message") return { ok: true, agent: { id: params.id }, text: "摘要" };
    if (method === "herdr.stop") return { ok: true };
    throw new Error(`unexpected method ${method}`);
  });
  try {
    const save = await POST(
      new Request("http://localhost/api/fleet", {
        method: "POST",
        headers: { "Content-Type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({ action: "save", profile }),
      }),
    );
    assert.equal(save.status, 200);

    const wake = await POST(
      new Request("http://localhost/api/fleet", {
        method: "POST",
        headers: { "Content-Type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({ action: "wake", id: "fleet-new" }),
      }),
    );
    assert.equal(wake.status, 200);

    const message = await POST(
      new Request("http://localhost/api/fleet", {
        method: "POST",
        headers: { "Content-Type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({ action: "message", id: "herdr-1", message: "hi" }),
      }),
    );
    assert.equal(message.status, 200);
    assert.deepEqual(
      stub.calls.map((call) => call.method),
      ["fleet.save", "fleet.wake", "fleet.message"],
    );
    assert.deepEqual(stub.calls[2].params, { id: "herdr-1", message: "hi" });
  } finally {
    stub.restore();
  }
});

test("POST /api/fleet rejects unknown actions", async () => {
  const stub = stubClient(() => ({ ok: true }));
  try {
    const res = await POST(
      new Request("http://localhost/api/fleet", {
        method: "POST",
        headers: { "Content-Type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({ action: "nope" }),
      }),
    );
    assert.equal(res.status, 400);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});
