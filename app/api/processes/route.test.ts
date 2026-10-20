import test from "node:test";
import assert from "node:assert/strict";
import { POST } from "./route.ts";

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

test("POST /api/processes force-stops a managed process", async () => {
  const stub = stubClient((method) => (method === "processes.forceStop" ? { ok: true } : {}));
  try {
    const res = await POST(
      new Request("http://localhost/api/processes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "force-stop", id: "proc-1" }),
      }),
    );
    assert.equal(res.status, 200);
    assert.equal((await res.json()).success, true);
    assert.equal(stub.calls[0]?.method, "processes.forceStop");
    assert.equal(stub.calls[0]?.params.id, "proc-1");
  } finally {
    stub.restore();
  }
});

test("POST /api/processes start marks manual starts as user-owned", async () => {
  const stub = stubClient((method, params) => {
    if (method === "files.authorize") return { realPath: params.path };
    if (method === "processes.start") {
      return {
        process: {
          id: "proc-2",
          owner: params.owner,
          status: "starting",
          readiness: "pending",
        },
      };
    }
    return {};
  });
  try {
    const res = await POST(
      new Request("http://localhost/api/processes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start", cwd: "/project", command: "npm run dev" }),
      }),
    );
    assert.equal(res.status, 200);
    const startCall = stub.calls.find((call) => call.method === "processes.start");
    assert.ok(startCall);
    assert.equal(startCall.params.owner, "user");
  } finally {
    stub.restore();
  }
});

test("POST /api/processes rejects unknown actions", async () => {
  const res = await POST(
    new Request("http://localhost/api/processes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "obliterate", id: "x" }),
    }),
  );
  assert.equal(res.status, 400);
});
