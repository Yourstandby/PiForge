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
  return {
    calls,
    restore: () => {
      globalThis.__piforgeAgentHostClient = previous;
    },
  };
}

test("GET /api/subagents proxies the host list", async () => {
  const stub = stubClient(() => ({
    agents: [
      {
        id: "subagent-1",
        name: "researcher",
        task: "look around",
        parentSessionId: "s1",
        status: "running",
        startedAt: 1,
        endedAt: null,
        durationMs: 2,
        output: "",
        toolCalls: [],
      },
    ],
  }));
  try {
    const res = await GET(new Request("http://localhost/api/subagents"));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.agents[0].name, "researcher");
    assert.equal(stub.calls[0]?.method, "subagents.list");
  } finally {
    stub.restore();
  }
});

test("POST /api/subagents stops a child and validates input", async () => {
  const stub = stubClient(() => ({ ok: true }));
  try {
    const res = await POST(
      new Request("http://localhost/api/subagents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop", id: "subagent-1" }),
      }),
    );
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
    assert.equal(stub.calls[0]?.method, "subagents.stop");
    assert.equal(stub.calls[0]?.params.id, "subagent-1");

    const badAction = await POST(
      new Request("http://localhost/api/subagents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "kill", id: "x" }),
      }),
    );
    assert.equal(badAction.status, 400);

    const missingId = await POST(
      new Request("http://localhost/api/subagents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop" }),
      }),
    );
    assert.equal(missingId.status, 400);
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});
