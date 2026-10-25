import test from "node:test";
import assert from "node:assert/strict";
import { GET, POST } from "./route.ts";

function stubClient(handler: (method: string, params: Record<string, unknown>) => unknown) {
  const previous = globalThis.__piforgeAgentHostClient;
  const calls: Array<{
    method: string;
    params: Record<string, unknown>;
    options?: { timeoutMs?: number };
  }> = [];
  globalThis.__piforgeAgentHostClient = {
    call: async (
      method: string,
      params: Record<string, unknown>,
      options?: { timeoutMs?: number },
    ) => {
      calls.push({ method, params, ...(options ? { options } : {}) });
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

test("GET /api/sessions/[id]/branches proxies the host tree", async () => {
  const stub = stubClient(() => ({ live: false, leafId: "b", nodes: [] }));
  try {
    const res = await GET(
      new Request("http://localhost/api/sessions/s1/branches?filePath=%2Ftmp%2Fs1.jsonl"),
      { params: Promise.resolve({ id: "s1" }) },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.leafId, "b");
    assert.equal(stub.calls[0]?.method, "sessions.getBranches");
    assert.equal(stub.calls[0]?.params.sessionId, "s1");
    assert.equal(stub.calls[0]?.params.filePath, "/tmp/s1.jsonl");
  } finally {
    stub.restore();
  }
});

test("POST /api/sessions/[id]/branches switches the leaf", async () => {
  const stub = stubClient((_method, params) => ({
    cancelled: false,
    live: true,
    leafId: params.leafId,
  }));
  try {
    const res = await POST(
      new Request("http://localhost/api/sessions/s1/branches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leafId: "a", filePath: "/tmp/s1.jsonl" }),
      }),
      { params: Promise.resolve({ id: "s1" }) },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.leafId, "a");
    assert.equal(stub.calls[0]?.method, "sessions.switchBranch");
    assert.equal(stub.calls[0]?.params.leafId, "a");
  } finally {
    stub.restore();
  }
});

test("POST forwards the distill flag and widens the RPC deadline", async () => {
  const stub = stubClient((_method, params) => ({
    cancelled: false,
    live: true,
    leafId: params.leafId,
    summarized: true,
    summaryText: "distilled",
  }));
  try {
    const res = await POST(
      new Request("http://localhost/api/sessions/s1/branches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leafId: "main-leaf", summarize: true }),
      }),
      { params: Promise.resolve({ id: "s1" }) },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.summarized, true);
    assert.equal(stub.calls[0]?.method, "sessions.switchBranch");
    assert.equal(stub.calls[0]?.params.summarize, true);
    // 蒸馏要跑一次模型调用，不能沿用 15s 的默认超时。
    assert.equal(stub.calls[0]?.options?.timeoutMs, 300_000);
  } finally {
    stub.restore();
  }
});

test("POST rejects a malformed leafId", async () => {
  const stub = stubClient(() => ({}));
  try {
    const res = await POST(
      new Request("http://localhost/api/sessions/s1/branches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leafId: "" }),
      }),
      { params: Promise.resolve({ id: "s1" }) },
    );
    assert.equal(res.status, 400);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});
