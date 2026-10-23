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
  return { calls, restore: () => { globalThis.__piforgeAgentHostClient = previous; } };
}

const ctx = { params: Promise.resolve({ id: "session-1" }) };

function post(body: unknown, origin?: string) {
  return POST(
    new Request("http://localhost/api/agent/session-1/intervene", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(origin ? { Origin: origin } : {}),
      },
      body: JSON.stringify(body),
    }),
    ctx,
  );
}

test("intervene forwards skip to agent.intervene and returns the reset task", async () => {
  const stub = stubClient(() => ({
    ok: true,
    actionType: "skip",
    delivered: "steer",
    message: "[系统提示] …",
    task: { taskId: "s~1", sessionId: "session-1", status: "running" },
    detail: "已向 Agent 发送跳过指令，看门狗计时已重置",
  }));
  try {
    const res = await post({ actionType: "skip" });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { ok: boolean; task: { status: string } };
    assert.equal(data.ok, true);
    assert.equal(data.task.status, "running");
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0]?.method, "agent.intervene");
    assert.deepEqual(stub.calls[0]?.params, { sessionId: "session-1", actionType: "skip" });
  } finally {
    stub.restore();
  }
});

test("intervene rejects unknown action types before touching the host", async () => {
  const stub = stubClient(() => ({ ok: true }));
  try {
    for (const body of [{ actionType: "abort" }, {}, { actionType: 1 }]) {
      const res = await post(body);
      assert.equal(res.status, 400);
    }
    const broken = await POST(
      new Request("http://localhost/api/agent/session-1/intervene", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      }),
      ctx,
    );
    assert.equal(broken.status, 400);
    assert.equal(stub.calls.length, 0, "参数不合法时不得调用 Host");
  } finally {
    stub.restore();
  }
});

test("intervene enforces the origin check", async () => {
  const stub = stubClient(() => ({ ok: true }));
  try {
    const res = await post({ actionType: "ask" }, "https://evil.example");
    assert.equal(res.status, 403);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test("host rejections surface as a normal JSON payload, not a 200 fake success", async () => {
  const stub = stubClient(() => ({
    ok: false,
    actionType: "skip",
    delivered: "queue",
    message: "",
    task: null,
    rejected: "duplicate",
    detail: "刚才已经发过同一条介入指令",
  }));
  try {
    const res = await post({ actionType: "skip" });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { ok: boolean; rejected: string };
    assert.equal(data.ok, false);
    assert.equal(data.rejected, "duplicate");
  } finally {
    stub.restore();
  }
});
